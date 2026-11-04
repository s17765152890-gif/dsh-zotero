/**
 * Unit coverage for the attachment write domain: the three-phase file
 * protocol against a scripted transport, the loopback-only upload rule, and
 * the pre-network argument checks. The live counterpart is the optional
 * `write-probe` integration spec (it needs a human for Zotero's authorize
 * dialog), so this spec pins the protocol shape without Zotero.
 * @module tests/local/write-attachments
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ZoteroHttpClient } from '../../src/http-client.js'
import type { WriteAuthorizer } from '../../src/write-auth.js'
import type { ZoteroWriteHttpClient } from '../../src/write-http.js'
import { attachFile } from '../../src/local/write-attachments.js'
import type { WriteDomainDeps } from '../../src/local/write-deps.js'
import { PERSONAL_LIBRARY } from '../../src/refs.js'
import type { ZoteroAttachFileResult, ZoteroWriteCommittedUnverified } from '../../src/types.js'

const SERVER_ID = 'SERVER1'
const KEY = 'KEYKEY01'
const PARENT_KEY = 'PARENT01'
const ATTACHMENT_KEY = 'ATTACH01'

interface Stubs {
  readonly deps: WriteDomainDeps
  readonly writer: {
    batch: ReturnType<typeof vi.fn>
    postForm: ReturnType<typeof vi.fn>
    upload: ReturnType<typeof vi.fn>
  }
  readonly authorizer: { keyFor: ReturnType<typeof vi.fn> }
}

function stubs(): Stubs {
  const writer = {
    batch: vi.fn(),
    postForm: vi.fn(),
    upload: vi.fn().mockResolvedValue({ status: 201, body: '' }),
  }
  const client = {
    serverId: SERVER_ID,
    get: vi.fn().mockResolvedValue({ status: 200, headers: new Headers(), body: '' }),
  }
  const authorizer = {
    keyFor: vi.fn().mockResolvedValue({ key: KEY, oneTime: false }),
    invalidate: vi.fn(),
    forget: vi.fn(),
  }
  const deps = {
    client: client as unknown as ZoteroHttpClient,
    writer: writer as unknown as ZoteroWriteHttpClient,
    authorizer: authorizer as unknown as WriteAuthorizer,
    resolveCollection: vi.fn(),
    resolveCollections: vi.fn(),
    itemTypeFields: vi.fn(),
  } as unknown as WriteDomainDeps
  return { deps, writer, authorizer }
}

function batchReceipt(): Record<string, unknown> {
  const data = {
    key: ATTACHMENT_KEY,
    version: 7,
    itemType: 'attachment',
    parentItem: PARENT_KEY,
    filename: 'paper.pdf',
    contentType: 'application/pdf',
  }
  return {
    successful: { 0: { key: ATTACHMENT_KEY, version: 7, data } },
    success: { 0: ATTACHMENT_KEY },
    unchanged: {},
    failed: {},
    libraryVersion: 9,
  }
}

function formResult(body: string, libraryVersion?: number) {
  const headers = new Headers()
  if (libraryVersion !== undefined) headers.set('last-modified-version', String(libraryVersion))
  return { status: body === '' ? 204 : 200, body, headers }
}

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zotero-attach-'))
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

const parentRef = { library: PERSONAL_LIBRARY, kind: 'item' as const, key: PARENT_KEY }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('attachFile', () => {
  it('creates the attachment item, uploads its bytes, and registers the file', async () => {
    const { deps, writer } = stubs()
    writer.batch.mockResolvedValue(batchReceipt())
    writer.postForm
      .mockResolvedValueOnce(
        formResult(
          JSON.stringify({
            url: 'http://127.0.0.1:23119/api/local/uploads/UP1',
            uploadKey: 'UP1',
          }),
        ),
      )
      .mockResolvedValueOnce(formResult('', 10))
    const path = await tempFile('paper.pdf', '%PDF-1.4\nprobe\n')

    const result = await attachFile(deps, { item: parentRef, path })

    expect(result.kind).toBe('applied')
    const applied = result as ZoteroAttachFileResult
    expect(applied).toMatchObject({
      key: ATTACHMENT_KEY,
      ref: `zotero://user/0/item/${ATTACHMENT_KEY}`,
      parentRef: 'zotero://user/0/item/PARENT01',
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      version: 7,
      libraryVersion: 10,
    })
    expect(applied.bytes).toBe(Buffer.byteLength('%PDF-1.4\nprobe\n'))

    // The create batch carries the attachment item shape Zotero expects.
    const [pathArg, entriesArg] = writer.batch.mock.calls[0] as [string, unknown[]]
    expect(pathArg).toBe('users/0/items')
    expect(entriesArg).toEqual([
      expect.objectContaining({
        itemType: 'attachment',
        parentItem: PARENT_KEY,
        linkMode: 'imported_file',
        filename: 'paper.pdf',
        contentType: 'application/pdf',
      }),
    ])

    // Authorize leg: md5 + filename + millisecond mtime under If-None-Match: *.
    const [, form, opts] = writer.postForm.mock.calls[0] as [
      string,
      Record<string, string>,
      Record<string, unknown>,
    ]
    expect(form).toMatchObject({
      filename: 'paper.pdf',
      filesize: String(Buffer.byteLength('%PDF-1.4\nprobe\n')),
      contentType: 'application/pdf',
    })
    expect(form.md5).toMatch(/^[a-f0-9]{32}$/)
    expect(Number(form.mtime)).toBeGreaterThan(1_000_000_000)
    expect(opts).toMatchObject({ serverId: SERVER_ID, apiKey: KEY, ifNoneMatch: '*' })

    // Bytes go to the returned loopback URL, with the upload key registered next.
    expect(writer.upload).toHaveBeenCalledWith(
      'http://127.0.0.1:23119/api/local/uploads/UP1',
      expect.any(Uint8Array),
      'application/pdf',
      expect.objectContaining({ signal: undefined }),
    )
    expect(writer.postForm.mock.calls[1]?.[1]).toEqual({ upload: 'UP1' })
  })

  it('refuses a non-loopback upload URL before sending bytes', async () => {
    const { deps, writer } = stubs()
    writer.batch.mockResolvedValue(batchReceipt())
    writer.postForm.mockResolvedValueOnce(
      formResult(JSON.stringify({ url: 'http://evil.example:23119/api/local/uploads/UP1', uploadKey: 'UP1' })),
    )
    const path = await tempFile('paper.pdf', '%PDF-1.4\nprobe\n')

    await expect(attachFile(deps, { item: parentRef, path })).rejects.toMatchObject({
      code: 'ZOTERO_UNEXPECTED',
    })
    expect(writer.upload).not.toHaveBeenCalled()
  })

  it('rejects a relative path before any network call', async () => {
    const { deps, writer } = stubs()

    await expect(attachFile(deps, { item: parentRef, path: 'paper.pdf' })).rejects.toMatchObject({
      code: 'ZOTERO_INVALID_ARGUMENT',
    })
    expect(writer.batch).not.toHaveBeenCalled()
  })

  it('reports a committed-unverified create instead of retrying', async () => {
    const { deps, writer } = stubs()
    const { ZoteroWriteCommitUnknownError } = await import('../../src/write-http.js')
    const { ZOTERO_UNEXPECTED } = await import('../../src/errors.js')
    writer.batch.mockRejectedValue(new ZoteroWriteCommitUnknownError('transport lost', ZOTERO_UNEXPECTED))
    const path = await tempFile('paper.pdf', '%PDF-1.4\nprobe\n')

    const result = await attachFile(deps, { item: parentRef, path })
    expect(result.kind).toBe('committed-unverified')
    expect((result as ZoteroWriteCommittedUnverified).retryable).toBe(false)
  })
})

