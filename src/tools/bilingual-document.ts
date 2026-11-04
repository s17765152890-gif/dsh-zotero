/**
 * The `zotero_bilingual_document` tool: turn a Zotero item's local PDF into a
 * side-by-side English | Chinese reading document (self-contained HTML plus a
 * Markdown mirror), translating body text, captions, and figure/table labels
 * with the session's current model.
 * @module dsh-zotero/tools/bilingual-document
 */

import { join } from 'node:path'
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
import { invalid, ZoteroError, ZOTERO_UNEXPECTED } from '../errors.js'
import { parseRef, formatRef } from '../refs.js'
import { buildBilingualDocument } from '../bilingual/document.js'
import { type LlmRuntime, type ModelSelection } from '../bilingual/types.js'
import { metaRecordOf } from './present.js'
import type { ZoteroService } from '../service.js'

const PARAMETERS = {
  ref: {
    type: 'string',
    required: true,
    description: 'Item ref whose best local PDF becomes the bilingual document (zotero://user/0/item/<KEY> or a group ref).',
  },
  pages: {
    type: 'string',
    description: 'Optional 1-based page range, e.g. "1-5" or "3". Omitted means the whole PDF.',
  },
  lang: {
    type: 'string',
    description: 'Target language tag (defaults to the configured bilingualTargetLang, "zh-CN").',
  },
  maxUnits: {
    type: 'integer',
    description: 'Optional cap on translated units; useful for a quick preview of a long paper.',
  },
  outputDir: {
    type: 'string',
    description: 'Optional absolute output root; defaults to the configured bilingualOutputDir or the session workspace "bilingual" folder.',
  },
} as const

type Args = InferArgs<typeof PARAMETERS>

const OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'generated', required: true },
    ref: { type: 'string', required: true },
    title: { type: 'string', required: true },
    htmlPath: { type: 'string', required: true },
    markdownPath: { type: 'string', required: true },
    cachePath: { type: 'string', required: true },
    pageCount: { type: 'integer', required: true },
    units: { type: 'integer', required: true },
    translated: { type: 'integer', required: true },
    untranslated: { type: 'integer', required: true },
    figureUnits: { type: 'integer', required: true },
    figureFragments: { type: 'integer', required: true },
    requests: { type: 'integer', required: true },
    failures: { type: 'integer', required: true },
    model: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        provider: { type: 'string', required: true },
        model: { type: 'string', required: true },
      },
    },
    elapsedMs: { type: 'integer', required: true },
  },
} as const

type Output = InferValue<typeof OUTPUT>

/** Parse "1-5" / "3" / "2-" into an inclusive page range. */
function parsePageRange(value: string | undefined): { firstPage?: number; lastPage?: number } {
  if (value === undefined) return {}
  const match = /^\s*(\d+)\s*(?:-\s*(\d+)?\s*)?$/.exec(value)
  if (match === null) invalid('pages must look like "3", "1-5", or "2-"')
  const first = Number.parseInt(match[1] ?? '', 10)
  if (!Number.isSafeInteger(first) || first < 1) invalid('pages must start at page 1 or later')
  const lastRaw = match[2]
  if (lastRaw === undefined) return { firstPage: first, lastPage: first }
  const last = Number.parseInt(lastRaw, 10)
  if (!Number.isSafeInteger(last) || last < first) invalid('pages range end must be >= start')
  return { firstPage: first, lastPage: last }
}

/** Session workspace: the agent session's cwd, then the process cwd. */
function sessionWorkspace(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  const cwd = exec.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/** Resolve the model route: explicit config, then the session agent, then the default selection. */
function resolveModel(
  ctx: Context,
  service: ZoteroService,
  exec: { agent?: { options?: { provider?: string; model?: string; reasoningEffort?: unknown } } },
): ModelSelection {
  const config = service.config
  const agentOptions = exec.agent?.options
  const provider = config.bilingualProvider !== '' ? config.bilingualProvider : agentOptions?.provider
  const model = config.bilingualModel !== '' ? config.bilingualModel : agentOptions?.model
  if (provider !== undefined && provider !== '' && model !== undefined && model !== '') {
    const effort = agentOptions?.reasoningEffort
    return {
      provider,
      model,
      ...(typeof effort === 'string' ? { reasoningEffort: effort as never } : {}),
    }
  }
  const defaults = (
    ctx as unknown as {
      agentDefaultModel?: { currentSelection?: () => ModelSelection | undefined }
    }
  ).agentDefaultModel
  const fallback = defaults?.currentSelection?.()
  if (fallback !== undefined) return fallback
  throw new ZoteroError(
    'No model route is available: set bilingualProvider/bilingualModel in the plugin config or select a model in the session.',
    ZOTERO_UNEXPECTED,
  )
}

function renderBilingual(_args: Args, value: Output): ContentBlock[] {
  const model = `${value.model.provider}/${value.model.model}`
  const lines = [
    `Bilingual document generated for ${value.ref}`,
    `HTML: ${value.htmlPath}`,
    `Markdown: ${value.markdownPath}`,
    `Pages: ${value.pageCount} · units: ${value.units} (translated ${value.translated}, untranslated ${value.untranslated})`,
    `Figure units: ${value.figureUnits} (${value.figureFragments} label fragments)`,
    `Model: ${model} · LLM requests: ${value.requests} (failures ${value.failures}) · ${value.elapsedMs} ms`,
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}

function presentBilingualMeta(_args: Args, value: Output): JsonValue {
  return {
    kind: 'generated',
    htmlPath: value.htmlPath,
    translated: value.translated,
    pages: value.pageCount,
  }
}

function presentBilingualResult(_args: Args, result: ToolResult): ToolResultView | undefined {
  const record = metaRecordOf(result)
  if (record === undefined || typeof record.htmlPath !== 'string') return undefined
  return { card: 'generic', title: `Bilingual document: ${record.translated ?? 0} units translated` }
}

export function registerBilingualDocumentTool(ctx: Context, service: ZoteroService): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'zotero_bilingual_document',
      description:
        "Build a side-by-side English | Chinese reading document from a Zotero item's local PDF: paragraphs, headings, captions, and figure/table label text are translated with the session's current model and rendered into one self-contained HTML file plus a Markdown mirror. " +
        'Translation is batched and cached next to the output, so re-running a partially translated document resumes instead of starting over. Long PDFs can be previewed with maxUnits or limited with pages.',
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT,
        render: renderBilingual,
        presentationMeta: presentBilingualMeta,
      },
      presentCall: (args) => ({
        card: 'generic',
        kind: 'edit',
        title: 'Build bilingual document',
        rawInput: args.ref,
      }),
      presentResult: presentBilingualResult,
      async execute(args, exec): Promise<Output> {
        const ref = parseRef(args.ref)
        const range = parsePageRange(args.pages)
        const location = await service.attachment(ref, exec.signal)
        if (location.kind !== 'file') {
          throw new ZoteroError(
            `Attachment ${location.ref} is a linked URL, not a local file; download it into Zotero first.`,
            ZOTERO_UNEXPECTED,
          )
        }
        const targetLang = args.lang ?? service.config.bilingualTargetLang
        const outputRoot =
          args.outputDir ??
          (service.config.bilingualOutputDir !== ''
            ? service.config.bilingualOutputDir
            : join(sessionWorkspace(exec as never), 'bilingual'))
        const model = resolveModel(ctx, service, exec as never)
        try {
          const built = await buildBilingualDocument({
            pdfPath: location.path,
            title: location.title,
            itemRef: formatRef(ref),
            itemKey: 'key' in ref ? ref.key : 'item',
            outputRoot,
            llm: ctx.llm as unknown as LlmRuntime,
            model,
            targetLang,
            sourceLang: 'English',
            ...range,
            ...(args.maxUnits === undefined ? {} : { maxUnits: args.maxUnits }),
            batchChars: service.config.bilingualBatchChars,
            signal: exec.signal,
          })
          return {
            kind: 'generated',
            ref: built.itemRef,
            title: built.title,
            htmlPath: built.htmlPath,
            markdownPath: built.markdownPath,
            cachePath: built.cachePath,
            pageCount: built.pageCount,
            units: built.units,
            translated: built.translated,
            untranslated: built.untranslated,
            figureUnits: built.figureUnits,
            figureFragments: built.figureFragments,
            requests: built.requests,
            failures: built.failures,
            model: built.model,
            elapsedMs: built.elapsedMs,
          } satisfies Output
        } catch (error) {
          if (error instanceof ZoteroError) throw error
          throw new ZoteroError(
            error instanceof Error ? error.message : String(error),
            ZOTERO_UNEXPECTED,
          )
        }
      },
    }),
  )
}
