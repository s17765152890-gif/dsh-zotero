/**
 * PDF text extraction for the bilingual reader: lines and paragraphs with
 * layout coordinates, figure/table caption detection, and the short label
 * fragments that live inside figures (axis labels, legends, diagram text).
 *
 * The extractor deliberately stops at geometry and text — translation and
 * rendering are separate modules so a cached extract can be re-translated
 * without re-reading the PDF.
 * @module dsh-zotero/bilingual/extract
 */

import { readFile } from 'node:fs/promises'
import { getDocumentProxy } from 'unpdf'

/** One `getTextContent` item projected onto the page coordinate system. */
export interface TextFragment {
  text: string
  /** Left edge in PDF user units (origin bottom-left). */
  x: number
  /** Baseline y in PDF user units. */
  y: number
  width: number
  height: number
  fontSize: number
  /** True when the fragment carries a rotation (chart side labels, vertical text). */
  rotated: boolean
}

/** One visual line: fragments merged left-to-right on a shared baseline. */
export interface DocLine {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  rotated: boolean
  fragments: number
}

/** A translatable unit extracted from the page. */
export interface DocUnit {
  id: string
  kind: 'heading' | 'paragraph' | 'caption' | 'figure'
  page: number
  text: string
  /** The figure caption a `figure` unit belongs to, when one was found. */
  caption?: string
}

/** One page of extracted content. */
export interface ExtractedPage {
  page: number
  units: DocUnit[]
}

/** The whole extraction result. */
export interface ExtractedDocument {
  pageCount: number
  pages: ExtractedPage[]
  /** Number of figure-label fragments captured across pages. */
  figureFragments: number
  /** True when the PDF yielded text; a scanned PDF reports false. */
  hasText: boolean
}

export interface ExtractOptions {
  /** 1-based inclusive page range. Omitted means the whole document. */
  firstPage?: number
  lastPage?: number
  /** Hard cap on pages extracted in one call (defaults to the whole document). */
  maxPages?: number
}

const CAPTION_RE = /^(?:figure|fig\.?|table|tab\.?|图|表)\s*([0-9]+|[ivxIVX]+)\b/i
const HEADING_NUMBER_RE = /^(?:\d+(?:\.\d+)*|[IVX]+\.)\s+\S/

/** Read the PDF bytes and extract translatable units from the requested pages. */
export async function extractDocument(
  pdfPath: string,
  options: ExtractOptions = {},
): Promise<ExtractedDocument> {
  const data = new Uint8Array(await readFile(pdfPath))
  const doc = await getDocumentProxy(data)
  const pageCount = doc.numPages
  const first = Math.max(1, options.firstPage ?? 1)
  const last = Math.min(pageCount, options.lastPage ?? pageCount)
  const cap = options.maxPages ?? Number.POSITIVE_INFINITY
  const pages: ExtractedPage[] = []
  let figureFragments = 0

  for (let pageNo = first; pageNo <= last && pages.length < cap; pageNo++) {
    const page = await doc.getPage(pageNo)
    const view = page.view
    const pageHeight = view[3] - view[1]
    const pageWidth = view[2] - view[0]
    const content = await page.getTextContent()
    const fragments = toFragments(content.items)
    const bodySize = dominantFontSize(fragments)
    const lines = mergeLines(fragments, bodySize)
    const { units, figureCount } = classifyLines(lines, pageNo, bodySize, pageWidth, pageHeight)
    figureFragments += figureCount
    pages.push({ page: pageNo, units })
  }

  return {
    pageCount: pages.length,
    pages,
    figureFragments,
    hasText: pages.some((page) => page.units.length > 0),
  }
}

/** Project pdf.js text items onto `TextFragment`s, dropping blank fragments. */
function toFragments(items: readonly unknown[]): TextFragment[] {
  const out: TextFragment[] = []
  for (const raw of items) {
    const item = raw as {
      str?: unknown
      transform?: unknown
      width?: unknown
      height?: unknown
    }
    if (typeof item.str !== 'string' || item.str.trim() === '') continue
    const transform = Array.isArray(item.transform) ? (item.transform as number[]) : undefined
    if (transform === undefined || transform.length < 6) continue
    const a = transform[0] ?? 0
    const b = transform[1] ?? 0
    const c = transform[2] ?? 0
    const d = transform[3] ?? 0
    const fontSize = Math.hypot(c, d) || Math.hypot(a, b) || 10
    out.push({
      text: item.str,
      x: transform[4] ?? 0,
      y: transform[5] ?? 0,
      width: typeof item.width === 'number' ? item.width : (item.str.length * fontSize) / 2,
      height: typeof item.height === 'number' ? (item.height as number) : fontSize,
      fontSize,
      rotated: Math.abs(b) > 0.01 || Math.abs(c) > 0.01,
    })
  }
  return out
}

/** The most common rounded font size, weighted by character count. */
function dominantFontSize(fragments: readonly TextFragment[]): number {
  const weights = new Map<number, number>()
  for (const fragment of fragments) {
    const key = Math.round(fragment.fontSize * 2) / 2
    weights.set(key, (weights.get(key) ?? 0) + fragment.text.length)
  }
  let best = 10
  let bestWeight = -1
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size
      bestWeight = weight
    }
  }
  return best
}

/** Merge fragments sharing a baseline into visual lines, in reading order. */
function mergeLines(fragments: readonly TextFragment[], bodySize: number): DocLine[] {
  const rows: TextFragment[][] = []
  const sorted = [...fragments].sort((a, b) => b.y - a.y || a.x - b.x)
  for (const fragment of sorted) {
    const tolerance = Math.max(1.5, bodySize * 0.35)
    const row = rows.find((candidate) => Math.abs((candidate[0]?.y ?? -1e9) - fragment.y) <= tolerance)
    if (row === undefined) rows.push([fragment])
    else row.push(fragment)
  }
  const lines: DocLine[] = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    let text = ''
    let previousRight: number | undefined
    for (const fragment of row) {
      const gap = previousRight === undefined ? 0 : fragment.x - previousRight
      const space = previousRight !== undefined && gap > fragment.fontSize * 0.18 ? ' ' : ''
      text += space + fragment.text
      previousRight = fragment.x + fragment.width
    }
    const first = row[0]
    if (first === undefined) continue
    const right = row.reduce((max, fragment) => Math.max(max, fragment.x + fragment.width), first.x)
    lines.push({
      text: text.replace(/\s+/g, ' ').trim(),
      x: first.x,
      y: first.y,
      width: right - first.x,
      height: Math.max(...row.map((fragment) => fragment.fontSize)),
      fontSize: Math.max(...row.map((fragment) => fragment.fontSize)),
      rotated: row.some((fragment) => fragment.rotated),
      fragments: row.length,
    })
  }
  return lines.sort((a, b) => b.y - a.y || a.x - b.x)
}

interface Classified {
  units: DocUnit[]
  figureCount: number
}

/**
 * Split visual lines into paragraphs, headings, captions, and figure label
 * fragments. Body lines are wide, regular-size lines that form a column;
 * everything else on the page is a label fragment (chart text, page numbers,
 * headers) and is routed to the figure bucket of its page.
 */
function classifyLines(
  lines: readonly DocLine[],
  page: number,
  bodySize: number,
  pageWidth: number,
  pageHeight: number,
): Classified {
  const units: DocUnit[] = []
  let paragraph: { id: string; lines: string[]; lastY: number; lastX: number } | undefined
  const figures: { caption?: string; fragments: string[] }[] = []
  let currentFigure: { caption?: string; fragments: string[] } | undefined
  let figureCount = 0

  const flushParagraph = (): void => {
    if (paragraph === undefined) return
    const text = paragraph.lines.join(' ').replace(/\s+/g, ' ').trim()
    if (text !== '') units.push({ id: `p${page}-b${units.length}`, kind: 'paragraph', page, text })
    paragraph = undefined
  }
  const flushFigure = (): void => {
    if (currentFigure !== undefined && currentFigure.fragments.length > 0) {
      const text = currentFigure.fragments.join(' · ')
      units.push({
        id: `p${page}-f${figures.length}`,
        kind: 'figure',
        page,
        text,
        ...(currentFigure.caption === undefined ? {} : { caption: currentFigure.caption }),
      })
      figures.push(currentFigure)
      figureCount += currentFigure.fragments.length
    }
    currentFigure = undefined
  }

  for (const line of lines) {
    const text = line.text
    if (text === '') continue
    const inMargin = line.y > pageHeight * 0.9 || line.y < pageHeight * 0.09
    const caption = CAPTION_RE.test(text)
    const heading =
      !caption &&
      !line.rotated &&
      (line.fontSize >= bodySize * 1.18 || (HEADING_NUMBER_RE.test(text) && line.width < pageWidth * 0.85))
    const bodySizeLine = line.fontSize >= bodySize * 0.88 && line.fontSize <= bodySize * 1.15
    const continuesParagraph =
      paragraph !== undefined &&
      bodySizeLine &&
      !line.rotated &&
      Math.abs(line.x - paragraph.lastX) <= 45 &&
      paragraph.lastY - line.y <= bodySize * 2.4 &&
      text.length >= 8
    const body =
      !caption &&
      !heading &&
      !line.rotated &&
      bodySizeLine &&
      (continuesParagraph ||
        (line.width >= pageWidth * 0.55 && text.length >= 25))

    if (body) {
      flushFigure()
      if (
        paragraph === undefined ||
        Math.abs(line.x - paragraph.lastX) > 40 ||
        paragraph.lastY - line.y > bodySize * 2.4
      ) {
        flushParagraph()
        paragraph = { id: `p${page}-b${units.length}`, lines: [text], lastY: line.y, lastX: line.x }
      } else {
        paragraph.lines.push(text)
        paragraph.lastY = line.y
      }
      continue
    }

    if (caption) {
      flushParagraph()
      // Labels collected above a caption belong to the same figure: adopt the
      // caption instead of flushing them as an anonymous cluster.
      if (currentFigure !== undefined && currentFigure.caption === undefined && currentFigure.fragments.length > 0) {
        currentFigure.caption = text
        units.push({ id: `p${page}-c${units.length}`, kind: 'caption', page, text })
        flushFigure()
      } else {
        flushFigure()
        currentFigure = { caption: text, fragments: [] }
        units.push({ id: `p${page}-c${units.length}`, kind: 'caption', page, text })
      }
      continue
    }

    if (heading) {
      flushParagraph()
      flushFigure()
      units.push({ id: `p${page}-h${units.length}`, kind: 'heading', page, text })
      continue
    }

    // Remaining lines are label fragments: figure text, running headers,
    // page numbers, table cells. Margins and obvious metadata are excluded;
    // the rest are routed to the current figure when one is open.
    if (inMargin) continue
    if (!looksLikeFigureLabel(text)) continue
    if (currentFigure === undefined) currentFigure = { fragments: [] }
    currentFigure.fragments.push(text)
  }
  flushParagraph()
  flushFigure()

  // Pages without any caption almost never carry figure text: the leftovers
  // are mastheads, affiliations, footnotes, or page furniture. Drop them and
  // recount the figure fragments so the report stays truthful.
  const captionPages = new Set(
    units.filter((unit) => unit.kind === 'caption').map((unit) => unit.page),
  )
  const kept = units.filter((unit) => unit.kind !== 'figure' || captionPages.has(unit.page))
  let keptFragments = 0
  for (const unit of kept) {
    if (unit.kind === 'figure') keptFragments += unit.text.split(' · ').length
  }
  return { units: kept, figureCount: keptFragments }
}

/** Reject metadata fragments that only look like labels on a chart. */
function looksLikeFigureLabel(text: string): boolean {
  const value = text.trim()
  if (value.length === 0 || value.length > 80) return false
  if (/^(?:https?:\/\/|www\.|doi:)/i.test(value)) return false
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(value)) return false
  if (/^(?:ISSN|ISBN|https)\b/i.test(value)) return false
  // Initials, pure punctuation, and bare page numbers are noise, not labels.
  if (/^[A-Za-z][.,]?$/.test(value)) return false
  if (/^[\d\s.,;:()/–—-]+$/.test(value)) return false
  return true
}
