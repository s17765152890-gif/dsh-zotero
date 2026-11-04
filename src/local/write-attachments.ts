/**
 * The attachment write domain: create an imported-file attachment from a
 * local file and drive Zotero 10's three-phase file protocol.
 *
 * Zotero 10's Local API accepts an attachment item like the web API, but the
 * file bytes travel separately (source-level facts: `server_localAPI.js`,
 * `Zotero.Server.LocalAPI.ItemFile` / `UploadReceiver`, Zotero 10):
 *
 * 1. `POST /items` creates the attachment item (`itemType: attachment`,
 *    `linkMode: imported_file`, `parentItem`, `filename`, `contentType`).
 *    The response is the ordinary batch receipt, so the create goes through
 *    {@link settleCreate} and a non-provable commit never retries.
 * 2. `POST /items/{key}/file` (no `upload=` field) authorizes the transfer:
 *    form fields `md5`, `filename`, `filesize`, `mtime` (milliseconds, not
 *    seconds), `contentType`, under `If-None-Match: *`. Zotero either answers
 *    `{ "exists": 1 }` (the stored file already matches) or issues an
 *    `uploadKey` plus a loopback upload URL.
 * 3. The bytes are POSTed to that absolute upload URL. The receiver
 *    authenticates nothing: the upload key in the URL is the capability, and
 *    the request must carry no local write headers.
 * 4. `POST /items/{key}/file` with `upload=<uploadKey>` registers the staged
 *    file and moves it into the attachment's storage directory, answering 204
 *    with the new library version.
 *
 * Every leg is a separate write request, and a single-use key is consumed at
 * authentication time, so each step re-resolves its key through
 * {@link withWriteKey} (an `Always Allow` grant makes the whole operation one
 * dialog; otherwise Zotero may ask per leg).
 *
 * The upload URL is validated to be loopback before any byte is sent: the
 * local API only ever returns its own address, and a redirect or a rewritten
 * response must not turn a write tool into an arbitrary exfiltration channel.
 * @module dsh-zotero/local/write-attachments
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import {
  ZOTERO_INVALID_ARGUMENT,
  WRITE_LIBRARY_VERSION_MISSING_MESSAGE,
  ZOTERO_UNEXPECTED,
  ZoteroError,
  requireNonBlank,
} from '../errors.js'
import { ZOTERO_LIBRARY_VERSION_HEADER } from '../constants.js'
import { asRecord, asString, parseNonNegativeSafeInteger } from '../json.js'
import { formatRef, libraryPrefix, PERSONAL_LIBRARY, requireWritableRef } from '../refs.js'
import { ensureServerId, requireWritableRefAtServer, withWriteKey } from './write-domain.js'
import { settleCreate } from './write-verdicts.js'
import type { WriteDomainDeps } from './write-deps.js'
import type {
  ZoteroAttachFileCommittedOutcome,
  ZoteroAttachFileRequest,
  ZoteroAttachFileResult,
} from '../types.js'

/** Zotero refuses uploads above 4 GB (`authorizeUpload`, server_localAPI.js). */
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024 * 1024

/** Extension → content type for the formats these tools actually receive. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.las': 'application/octet-stream',
  '.laz': 'application/octet-stream',
}

/** The file facts one attach needs; hashed before any network call. */
interface LocalFileFacts {
  readonly bytes: Uint8Array
  readonly size: number
  readonly mtimeMs: number
  readonly md5: string
  readonly filename: string
}

/** The authorize leg's answer, narrowed to what this domain uses. */
type AuthorizeLeg = { readonly exists: true } | { readonly url: string; readonly uploadKey: string }

function contentTypeOf(filename: string): string {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

/** Reject a path the write cannot read before any network call. */
function requireLocalFilePath(value: string): string {
  const path = requireNonBlank('path', value)
  if (!isAbsolute(path)) {
    throw new ZoteroError(
      'The attachment path must be absolute, because Zotero reads it on the machine it runs on.',
      ZOTERO_INVALID_ARGUMENT,
    )
  }
  return path
}

/** Read, hash, and bound one local file; a missing or unreadable path is an argument error. */
async function readLocalFile(path: string): Promise<LocalFileFacts> {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    throw new ZoteroError(
      `Cannot read the attachment file "${path}": ${error instanceof Error ? error.message : String(error)}`,
      ZOTERO_INVALID_ARGUMENT,
    )
  }
  if (!info.isFile()) {
    throw new ZoteroError(`The attachment path "${path}" is not a regular file.`, ZOTERO_INVALID_ARGUMENT)
  }
  if (info.size <= 0) {
    throw new ZoteroError(`The attachment file "${path}" is empty.`, ZOTERO_INVALID_ARGUMENT)
  }
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new ZoteroError(
      `The attachment file "${path}" exceeds Zotero's 4 GB upload limit.`,
      ZOTERO_INVALID_ARGUMENT,
    )
  }
  const bytes = await readFile(path)
  const md5 = createHash('md5').update(bytes).digest('hex')
  return {
    bytes,
    size: info.size,
    // Zotero rejects mtime values that look like seconds, so send milliseconds.
    mtimeMs: Math.max(1, Math.round(info.mtimeMs)),
    md5,
    filename: basename(path),
  }
}

/** Validate the upload URL Zotero returned: only its own loopback address may receive bytes. */
function requireLoopbackUploadUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ZoteroError('Zotero returned an invalid upload URL.', ZOTERO_UNEXPECTED)
  }
  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1'
  if (url.protocol !== 'http:' || !loopback) {
    throw new ZoteroError('Zotero returned a non-loopback upload URL; refusing to upload bytes.', ZOTERO_UNEXPECTED)
  }
  return url.href
}

/** Narrow the authorize leg's JSON body. */
function parseAuthorizeLeg(body: string): AuthorizeLeg {
  let json: unknown
  try {
    json = body === '' ? undefined : JSON.parse(body)
  } catch {
    throw new ZoteroError('Zotero returned an unparseable file-authorization answer.', ZOTERO_UNEXPECTED)
  }
  const record = asRecord(json)
  if (record === undefined) {
    throw new ZoteroError('Zotero returned an empty file-authorization answer.', ZOTERO_UNEXPECTED)
  }
  if (record.exists === 1) return { exists: true }
  const url = asString(record.url)
  const uploadKey = asString(record.uploadKey)
  if (url === undefined || uploadKey === undefined || uploadKey === '') {
    throw new ZoteroError('Zotero returned no upload URL for the attachment.', ZOTERO_UNEXPECTED)
  }
  return { url: requireLoopbackUploadUrl(url), uploadKey }
}

function libraryVersionOf(headers: Headers): number {
  const version = parseNonNegativeSafeInteger(headers.get(ZOTERO_LIBRARY_VERSION_HEADER))
  if (version === undefined) {
    throw new ZoteroError(WRITE_LIBRARY_VERSION_MISSING_MESSAGE, ZOTERO_UNEXPECTED)
  }
  return version
}

/**
 * Create one imported-file attachment under an existing item and register its
 * bytes. The parent ref is checked before any network call, and the file is
 * hashed before the attachment item exists, so an unreadable path never
 * leaves an empty attachment behind.
 */
export async function attachFile(
  deps: WriteDomainDeps,
  request: ZoteroAttachFileRequest,
  signal?: AbortSignal,
): Promise<ZoteroAttachFileCommittedOutcome> {
  const filePath = requireLocalFilePath(request.path)
  const localRef = requireWritableRef(request.item, ['item'])
  const serverId = await ensureServerId(deps, signal)
  const parent = requireWritableRefAtServer(localRef, ['item'], serverId)
  const local = await readLocalFile(filePath)
  const title = request.title?.trim() || local.filename
  const contentType = request.contentType?.trim() || contentTypeOf(local.filename)
  const entry: Record<string, unknown> = {
    itemType: 'attachment',
    parentItem: parent.key,
    linkMode: 'imported_file',
    title,
    filename: local.filename,
    contentType,
  }
  const itemsPath = `${libraryPrefix(PERSONAL_LIBRARY)}/items`
  const settled = await withWriteKey(deps, serverId, signal, async (apiKey) =>
    settleCreate(
      deps,
      { path: itemsPath, entry, serverId, apiKey, signal, kind: 'item' },
      (data): { filename: string; contentType: string } | undefined => {
        if (asString(data.itemType) !== 'attachment') return undefined
        if (asString(data.parentItem) !== parent.key) return undefined
        const filename = asString(data.filename)
        if (filename === undefined) return undefined
        return { filename, contentType: asString(data.contentType) ?? contentType }
      },
    ),
  )
  if (settled.status === 'unverified') return settled.result
  const { key, version, libraryVersion: createdLibraryVersion } = settled.entry
  const filePathApi = `${itemsPath}/${key}/file`
  let registeredLibraryVersion = createdLibraryVersion

  try {
    const authorize = await withWriteKey(deps, serverId, signal, async (apiKey) => {
      const { body } = await deps.writer.postForm(
        filePathApi,
        {
          md5: local.md5,
          filename: local.filename,
          filesize: String(local.size),
          mtime: String(local.mtimeMs),
          contentType,
        },
        { serverId, apiKey, signal, ifNoneMatch: '*' },
      )
      return parseAuthorizeLeg(body)
    })
    if (!('exists' in authorize)) {
      await deps.writer.upload(authorize.url, local.bytes, contentType, { signal })
      registeredLibraryVersion = await withWriteKey(deps, serverId, signal, async (apiKey) => {
        const { headers } = await deps.writer.postForm(
          filePathApi,
          { upload: authorize.uploadKey },
          { serverId, apiKey, signal, ifNoneMatch: '*', commitSensitive: true },
        )
        return libraryVersionOf(headers)
      })
    }
  } catch (error) {
    // The attachment item is already committed; its file leg is not. Report the
    // partial state with the created key instead of inviting a blind retry.
    const reason = error instanceof Error ? error.message : String(error)
    throw new ZoteroError(
      `Attachment item ${formatRef({ kind: 'item', library: PERSONAL_LIBRARY, key })} was created, ` +
        `but its file could not be uploaded (${reason}). Delete that empty attachment or retry with it.`,
      ZOTERO_UNEXPECTED,
      { cause: error },
    )
  }

  const result: ZoteroAttachFileResult = {
    kind: 'applied',
    ref: formatRef({ kind: 'item', library: PERSONAL_LIBRARY, key }),
    key,
    parentRef: formatRef(parent),
    title,
    filename: local.filename,
    contentType,
    bytes: local.size,
    version,
    libraryVersion: registeredLibraryVersion,
    serverId,
  }
  return result
}
