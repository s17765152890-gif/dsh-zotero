/**
 * The `zotero_attach_files` tool: create imported-file attachments from local
 * files under existing items, uploading each file through Zotero 10's
 * three-phase file protocol (authorize → upload → register).
 *
 * One tool call carries one plan and one review: a batch of N files is N
 * attachments under one approval. The file path is read on the machine
 * running Zotero; no bytes ride the model context.
 * @module dsh-zotero/tools/attach-files
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  defineTool,
  type InferArgs,
  type InferValue,
  type ToolResult,
  type ToolResultView,
} from '@deepseek-ai/dsh-tools'
import { invalid, requireNonBlank, writeListTooLongMessage } from '../errors.js'
import { renderDeclined } from './present.js'
import {
  COMMITTED_UNVERIFIED_VARIANT,
  DECLINED_OUTPUT_SCHEMA,
  libraryVersionLine,
} from './write-present.js'
import { parseWritableRef, WRITE_REF_ARG_HINT } from './validate.js'
import {
  WRITE_COMMITTED_UNVERIFIED_DESCRIPTION,
  WRITE_PLAN_LIBRARY_LINE,
  WRITE_PLAN_OUTCOME_DESCRIPTION,
} from '../write-approval.js'
import { ZOTERO_WRITE_OBJECT_BATCH } from '../constants.js'
import type { ZoteroService } from '../service.js'
import type {
  ZoteroAttachFileRequest,
  ZoteroAttachFileResult,
  ZoteroWriteCommittedUnverified,
} from '../types.js'

const PARAMETERS = {
  files: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        item: {
          type: 'string',
          required: true,
          description: `Parent ${WRITE_REF_ARG_HINT} item the attachment is created under.`,
        },
        path: {
          type: 'string',
          required: true,
          description:
            'Absolute path of the file on the machine running Zotero (for example E:\\papers\\paper.pdf). Zotero reads and uploads the bytes locally; the path never becomes model-visible content.',
        },
        title: {
          type: 'string',
          description: 'Attachment title; defaults to the file name.',
        },
        contentType: {
          type: 'string',
          description:
            'MIME type; defaults from the file extension (application/pdf for .pdf).',
        },
      },
    },
    description:
      'Files to attach: one entry per attachment, each with the parent item ref and an absolute local path (1..writeListMaxItems per call).',
  },
} as const
type Args = InferArgs<typeof PARAMETERS>

/** One created attachment as reported to the model. */
const ATTACHED_FILE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string', required: true },
    key: { type: 'string', required: true },
    parentRef: { type: 'string', required: true },
    title: { type: 'string' },
    filename: { type: 'string', required: true },
    contentType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    version: { type: 'integer', required: true },
    libraryVersion: { type: 'integer', required: true },
    serverId: { type: 'string' },
  },
} as const

const ATTACHED_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['attached'], required: true },
    attachments: { type: 'array', required: true, items: ATTACHED_FILE },
    serverId: { type: 'string' },
  },
} as const

const OUTPUT = {
  oneOf: [DECLINED_OUTPUT_SCHEMA, ATTACHED_OUTPUT, COMMITTED_UNVERIFIED_VARIANT],
} as const
type Output = InferValue<typeof OUTPUT>

/** The tool's own outcome vocabulary: service outcomes plus the batch envelope. */
type AttachFilesOutcome =
  | { kind: 'declined' }
  | ZoteroWriteCommittedUnverified
  | { kind: 'attached'; attachments: ZoteroAttachFileResult[]; serverId?: string }

/** The deterministic plan markdown the approval card renders. */
export function attachFilesPlan(args: Args): string {
  const lines = ['**Attach local files to Zotero items**', WRITE_PLAN_LIBRARY_LINE]
  for (const file of args.files) {
    const title = file.title === undefined ? '' : ` (title: ${file.title})`
    lines.push(`- ${file.path} → ${file.item}${title}`)
  }
  lines.push(`- Files: ${args.files.length}`)
  lines.push(
    "Each file becomes an imported-file attachment and is uploaded through Zotero's local file protocol.",
  )
  return lines.join('\n')
}

/** Validate the batch before any plan or network call. */
function buildRequests(args: Args): ZoteroAttachFileRequest[] {
  if (args.files.length > ZOTERO_WRITE_OBJECT_BATCH) {
    invalid(writeListTooLongMessage('files', ZOTERO_WRITE_OBJECT_BATCH))
  }
  return args.files.map((file) => ({
    item: parseWritableRef(requireNonBlank('item', file.item), ['item']),
    path: requireNonBlank('path', file.path),
    ...(file.title === undefined ? {} : { title: requireNonBlank('title', file.title) }),
    ...(file.contentType === undefined
      ? {}
      : { contentType: requireNonBlank('contentType', file.contentType) }),
  }))
}

export function renderAttachFiles(_args: Args, value: Output): ContentBlock[] {
  if (value.kind === 'declined') return renderDeclined()
  if (value.kind === 'committed-unverified') {
    return [
      {
        type: 'text',
        text: `Attachment create committed but could not be verified (${value.reason}). Do not retry; reconcile by key${value.key === undefined ? '' : ` ${value.key}`}.`,
      },
    ]
  }
  const lines = [`Attached ${value.attachments.length} file(s).`]
  for (const file of value.attachments) {
    lines.push(`- ${file.ref} under ${file.parentRef}: ${file.filename} (${file.bytes} bytes, ${file.contentType})`)
    lines.push(`  ${libraryVersionLine(file)}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Replayable projection: counts only, so the card can state them without rows. */
function presentAttachFilesMeta(_args: Args, value: Output): JsonValue {
  if (value.kind === 'declined') return { kind: 'declined' }
  if (value.kind === 'committed-unverified') {
    return { kind: 'committed-unverified', reason: value.reason }
  }
  return {
    kind: 'attached',
    attachments: value.attachments.length,
    ...(value.serverId === undefined ? {} : { serverId: value.serverId }),
  }
}

function presentAttachFilesResult(_args: Args, result: ToolResult): ToolResultView | undefined {
  const meta = result.meta
  const record =
    meta !== null && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : undefined
  if (record === undefined) return undefined
  if (record.kind === 'declined') {
    return { card: 'generic', title: 'Zotero attach files: declined, nothing written' }
  }
  if (record.kind === 'committed-unverified') {
    return { card: 'generic', title: 'Zotero attach files: committed, unverified' }
  }
  const count = typeof record.attachments === 'number' ? record.attachments : 0
  return { card: 'generic', title: `Zotero attach files: ${count} attached` }
}

export function registerAttachFilesTool(ctx: Context, service: ZoteroService): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'zotero_attach_files',
      description:
        'Attach existing local files as imported-file attachments under Zotero items, uploading each through the local file protocol. Give the parent item ref and an absolute path on the machine running Zotero. ' +
        WRITE_PLAN_OUTCOME_DESCRIPTION +
        WRITE_COMMITTED_UNVERIFIED_DESCRIPTION,
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT,
        render: renderAttachFiles,
        presentationMeta: presentAttachFilesMeta,
      },
      presentCall: (args) => ({
        card: 'generic',
        kind: 'edit',
        title: 'Attach Zotero files',
        rawInput: `${args.files.length} file(s)`,
      }),
      presentResult: presentAttachFilesResult,
      async execute(args, exec): Promise<AttachFilesOutcome> {
        const requests = buildRequests(args)
        const plan = attachFilesPlan(args)
        const attachments: ZoteroAttachFileResult[] = []
        let serverId: string | undefined
        for (const request of requests) {
          const outcome = await service.attachFile(request, { exec, plan })
          if (outcome.kind === 'declined') return { kind: 'declined' }
          if (outcome.kind === 'committed-unverified') return outcome
          attachments.push(outcome)
          serverId = outcome.serverId
        }
        return {
          kind: 'attached',
          attachments,
          ...(serverId === undefined ? {} : { serverId }),
        }
      },
    }),
  )
}
