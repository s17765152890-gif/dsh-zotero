/**
 * Orchestrate the bilingual reader: extract units from a local PDF, translate
 * the missing ones with the session model (resumable through a cache file),
 * render the side-by-side HTML and Markdown, and report what was produced.
 * @module dsh-zotero/bilingual/document
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { composeOutputPaths, outputRootFor } from './paths.js'
import { extractDocument } from './extract.js'
import { renderHtml, renderMarkdown } from './render.js'
import { translateUnits, type TranslateUnit } from './translate.js'
import { targetLanguageLabel, type LlmRuntime, type ModelSelection } from './types.js'

/** Everything the orchestrator needs from the caller. */
export interface BilingualBuildInput {
  pdfPath: string
  title: string
  itemRef: string
  itemKey: string
  /** Root directory the per-item folder lives under. */
  outputRoot: string
  llm: LlmRuntime
  model: ModelSelection
  targetLang: string
  sourceLang: string
  firstPage?: number
  lastPage?: number
  /** Translate at most this many units (a smoke-test cap); omitted means all. */
  maxUnits?: number
  batchChars?: number
  signal?: AbortSignal
}

/** The produced document and its statistics. */
export interface BilingualBuildResult {
  itemRef: string
  title: string
  htmlPath: string
  markdownPath: string
  cachePath: string
  pageCount: number
  units: number
  translated: number
  untranslated: number
  figureUnits: number
  figureFragments: number
  requests: number
  failures: number
  model: { provider: string; model: string }
  elapsedMs: number
}

interface CacheFile {
  version: 1
  model: string
  targetLang: string
  translations: Record<string, string>
}

/** Read the existing translation cache; a corrupt cache starts empty. */
async function readCache(path: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<CacheFile>
    return parsed.translations ?? {}
  } catch {
    return {}
  }
}

/**
 * Extract → translate → render one PDF into a bilingual document.
 * @param input - the PDF path, identity, model route, and output root.
 * @returns the produced paths and translation statistics.
 */
export async function buildBilingualDocument(
  input: BilingualBuildInput,
): Promise<BilingualBuildResult> {
  const started = Date.now()
  const extracted = await extractDocument(input.pdfPath, {
    ...(input.firstPage === undefined ? {} : { firstPage: input.firstPage }),
    ...(input.lastPage === undefined ? {} : { lastPage: input.lastPage }),
  })
  if (!extracted.hasText) {
    throw new Error(
      'PDF produced no extractable text (likely a scanned document); the bilingual reader needs a text layer.',
    )
  }
  const paths = composeOutputPaths(outputRootFor(input.outputRoot, input.itemKey))
  await mkdir(paths.dir, { recursive: true })
  const cached = await readCache(paths.cachePath)

  // Expand units into translation work: figure labels translate individually so
  // the rendered pairs stay aligned.
  const work: TranslateUnit[] = []
  const figureLabelIds = new Map<string, string[]>()
  for (const page of extracted.pages) {
    for (const unit of page.units) {
      if (unit.kind === 'figure') {
        const labels = unit.text.split(' · ').filter((label) => label !== '')
        const ids = labels.map((label, index) => `${unit.id}#${index}`)
        figureLabelIds.set(unit.id, ids)
        labels.forEach((label, index) => work.push({ id: ids[index]!, text: label }))
      } else {
        work.push({ id: unit.id, text: unit.text })
      }
    }
  }
  const capped = input.maxUnits === undefined ? work : work.slice(0, input.maxUnits)
  const missing = capped.filter((unit) => cached[unit.id] === undefined)
  const translation = await translateUnits(input.llm, input.model, missing, {
    targetLabel: targetLanguageLabel(input.targetLang),
    ...(input.batchChars === undefined ? {} : { batchChars: input.batchChars }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  const translations: Record<string, string> = { ...cached }
  for (const [id, text] of translation.translations) translations[id] = text
  await writeFile(
    paths.cachePath,
    JSON.stringify(
      {
        version: 1,
        model: `${input.model.provider}/${input.model.model}`,
        targetLang: input.targetLang,
        translations,
      } satisfies CacheFile,
      null,
      1,
    ),
    'utf8',
  )

  // Reassemble figure-unit translations from their label pieces.
  const perUnit = new Map<string, string>()
  for (const page of extracted.pages) {
    for (const unit of page.units) {
      if (unit.kind === 'figure') {
        const ids = figureLabelIds.get(unit.id) ?? []
        const labels = unit.text.split(' · ').filter((label) => label !== '')
        const parts = ids.map((id, index) => translations[id] ?? labels[index] ?? '')
        perUnit.set(unit.id, parts.join(' · '))
      } else {
        const value = translations[unit.id]
        if (value !== undefined) perUnit.set(unit.id, value)
      }
    }
  }

  const renderInput = {
    document: extracted,
    translations: perUnit,
    title: input.title,
    itemRef: input.itemRef,
    model: input.model,
    targetLang: targetLanguageLabel(input.targetLang),
    sourceLang: input.sourceLang,
    generatedAt: new Date(),
  }
  await writeFile(paths.htmlPath, renderHtml(renderInput), 'utf8')
  await writeFile(paths.markdownPath, renderMarkdown(renderInput), 'utf8')

  let translated = 0
  let untranslated = 0
  let figureUnits = 0
  for (const page of extracted.pages) {
    for (const unit of page.units) {
      if (unit.kind === 'figure') figureUnits += 1
      if (perUnit.get(unit.id) !== undefined) translated += 1
      else untranslated += 1
    }
  }
  return {
    itemRef: input.itemRef,
    title: input.title,
    htmlPath: paths.htmlPath,
    markdownPath: paths.markdownPath,
    cachePath: paths.cachePath,
    pageCount: extracted.pageCount,
    units: work.length,
    translated,
    untranslated,
    figureUnits,
    figureFragments: extracted.figureFragments,
    requests: translation.requests,
    failures: translation.failures,
    model: input.model,
    elapsedMs: Date.now() - started,
  }
}

