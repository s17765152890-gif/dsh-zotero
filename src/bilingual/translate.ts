/**
 * Batch translation over the harness LLM service. One call translates a batch
 * of extracted units with the session's model and returns a JSON map; the
 * caller owns rendering and caching on disk.
 * @module dsh-zotero/bilingual/translate
 */

import type { LlmRuntime, ModelSelection } from './types.js'

/** One translatable unit. */
export interface TranslateUnit {
  id: string
  text: string
}

/** Result of one translation pass. */
export interface TranslateResult {
  translations: Map<string, string>
  requests: number
  failures: number
  /** First few error messages encountered, for diagnosis. */
  errors: string[]
}

export interface TranslateOptions {
  /** Source language label used in the prompt (defaults to English). */
  sourceLabel?: string
  /** Target language label used in the prompt (defaults to Simplified Chinese). */
  targetLabel?: string
  /** Characters of source text per request (defaults to 6000). */
  batchChars?: number
  /** Units per request ceiling (defaults to 20). */
  batchUnits?: number
  signal?: AbortSignal
}

const SYSTEM_PROMPT =
  'You are a careful academic translator. Translate English academic prose, figure captions, chart axis labels, legends, and diagram text into Simplified Chinese. ' +
  'Preserve numbers, citations, author names, units, formulas, and acronyms exactly. ' +
  'Return ONLY a JSON array of objects {"id": string, "zh": string} — one per input item, same ids, no prose, no markdown fences.'

/** Translate units in bounded batches; failures are retried once as a split batch. */
export async function translateUnits(
  llm: LlmRuntime,
  selection: ModelSelection,
  units: readonly TranslateUnit[],
  options: TranslateOptions = {},
): Promise<TranslateResult> {
  const translations = new Map<string, string>()
  const batchChars = Math.max(1000, options.batchChars ?? 6000)
  const batchUnits = Math.max(1, options.batchUnits ?? 20)
  let requests = 0
  let failures = 0
  const errors: string[] = []
  const noteError = (error: unknown): void => {
    if (errors.length >= 3) return
    errors.push(error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300))
  }

  let batch: TranslateUnit[] = []
  let chars = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const current = batch
    batch = []
    chars = 0
    try {
      const map = await translateBatch(llm, selection, current, options)
      for (const [id, text] of map) translations.set(id, text)
      requests += 1
    } catch (error) {
      failures += 1
      noteError(error)
      // Split once: a malformed or truncated answer usually means one unit
      // dominated the response.
      if (current.length > 1) {
        const half = Math.ceil(current.length / 2)
        for (const part of [current.slice(0, half), current.slice(half)]) {
          try {
            const map = await translateBatch(llm, selection, part, options)
            for (const [id, text] of map) translations.set(id, text)
            requests += 1
          } catch (partError) {
            failures += 1
            noteError(partError)
          }
        }
      }
    }
  }

  for (const unit of units) {
    if (batch.length >= batchUnits || (chars > 0 && chars + unit.text.length > batchChars)) {
      await flush()
    }
    batch.push(unit)
    chars += unit.text.length
  }
  await flush()
  return { translations, requests, failures, errors }
}

/** One request: system+user prompts in, parsed id→translation map out. */
async function translateBatch(
  llm: LlmRuntime,
  selection: ModelSelection,
  units: readonly TranslateUnit[],
  options: TranslateOptions,
): Promise<Map<string, string>> {
  const payload = JSON.stringify(units.map((unit) => ({ id: unit.id, en: unit.text })))
  const user =
    `Source language: ${options.sourceLabel ?? 'English'}. Target language: ${options.targetLabel ?? 'Simplified Chinese'}.\n` +
    `Translate every item's "en" field. Return the JSON array only.\n\n${payload}`
  let text = ''
  const stream = llm.stream({
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    system: SYSTEM_PROMPT,
    maxTokens: 4000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  for await (const chunk of stream) {
    if ((chunk as { type?: string }).type === 'text-delta') {
      text += (chunk as { text?: string }).text ?? ''
    }
  }
  return parseTranslations(text)
}

/** Parse the model answer tolerantly: fenced JSON, prose around the array, reordered keys. */
export function parseTranslations(answer: string): Map<string, string> {
  const out = new Map<string, string>()
  const start = answer.indexOf('[')
  const end = answer.lastIndexOf(']')
  if (start < 0 || end <= start) {
    throw new Error('translation answer carried no JSON array')
  }
  const parsed = JSON.parse(answer.slice(start, end + 1)) as unknown
  if (!Array.isArray(parsed)) throw new Error('translation answer was not an array')
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = record.id
    const zh = record.zh ?? record.translation ?? record.text
    if (typeof id === 'string' && typeof zh === 'string' && zh.trim() !== '') {
      out.set(id, zh.trim())
    }
  }
  if (out.size === 0) throw new Error('translation answer carried no usable entries')
  return out
}

