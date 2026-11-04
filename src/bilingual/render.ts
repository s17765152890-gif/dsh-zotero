/**
 * Render a bilingual (source | translation) reading document from extracted
 * units and their translations: one self-contained HTML file plus a Markdown
 * mirror. The HTML is the deliverable; the Markdown keeps the content usable
 * in editors and chat previews.
 * @module dsh-zotero/bilingual/render
 */

import type { ExtractedDocument, DocUnit } from './extract.js'

export interface RenderInput {
  document: ExtractedDocument
  translations: ReadonlyMap<string, string>
  title: string
  itemRef: string
  model: { provider: string; model: string }
  targetLang: string
  sourceLang: string
  generatedAt: Date
}

/** Escape text for HTML text nodes and attributes. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Render the self-contained bilingual HTML document. */
export function renderHtml(input: RenderInput): string {
  const { document, translations } = input
  const body: string[] = []
  let translated = 0
  let missing = 0
  for (const page of document.pages) {
    if (page.units.length === 0) continue
    body.push(`<section class="page" id="page-${page.page}">`)
    body.push(`<h2 class="page-title">Page ${page.page} / 第 ${page.page} 页</h2>`)
    for (const unit of page.units) {
      const zh = translations.get(unit.id)
      if (zh === undefined) missing += 1
      else translated += 1
      body.push(renderUnit(unit, zh))
    }
    body.push('</section>')
  }
  const stats = `模型 ${input.model.provider}/${input.model.model} · 已译 ${translated} 段 · 未译 ${missing} 段 · ${input.document.pageCount} 页`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} — 双语对照</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 1180px; padding: 24px 28px 80px; font: 16px/1.65 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background: #fafaf8; color: #1f2328; }
  header.doc { border-bottom: 2px solid #d0d7de; padding-bottom: 14px; margin-bottom: 24px; }
  header.doc h1 { margin: 0 0 6px; font-size: 26px; line-height: 1.3; }
  header.doc .meta { color: #57606a; font-size: 13px; }
  header.doc .ref { color: #57606a; font-size: 12px; word-break: break-all; }
  section.page { margin: 0 0 40px; }
  h2.page-title { font-size: 14px; letter-spacing: .04em; text-transform: none; color: #57606a; border-bottom: 1px solid #e4e8ec; padding-bottom: 6px; margin: 32px 0 16px; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; padding: 10px 0; border-bottom: 1px dashed #e4e8ec; }
  .row:last-child { border-bottom: 0; }
  .src { color: #24292f; }
  .dst { color: #0b5cad; }
  .row.heading .src { font-weight: 700; font-size: 18px; }
  .row.heading .dst { font-weight: 700; font-size: 17px; }
  .row.caption .src, .row.caption .dst { font-size: 14px; color: #57606a; }
  .figure { margin: 14px 0; padding: 12px 14px; background: #f0f4f8; border-left: 3px solid #8fb3d9; border-radius: 4px; }
  .figure h3 { margin: 0 0 8px; font-size: 14px; color: #34495e; }
  .figure .pairs { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px 18px; font-size: 14px; }
  .figure .pairs .en { color: #444; }
  .figure .pairs .zh { color: #0b5cad; }
  .tag { display: inline-block; font-size: 11px; color: #6a737d; border: 1px solid #d0d7de; border-radius: 10px; padding: 0 6px; margin-right: 6px; vertical-align: 1px; }
  @media (max-width: 820px) { .row { grid-template-columns: 1fr; } .figure .pairs { grid-template-columns: 1fr; } }
  @media print { body { background: #fff; } .row { break-inside: avoid; } }
</style>
</head>
<body>
<header class="doc">
  <h1>${escapeHtml(input.title)}</h1>
  <div class="meta">${escapeHtml(stats)} · 原文 ${escapeHtml(input.sourceLang)} → 译文 ${escapeHtml(input.targetLang)} · ${input.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</div>
  <div class="ref">${escapeHtml(input.itemRef)}</div>
</header>
${body.join('\n')}
</body>
</html>
`
}

/** Render one unit as a two-column row or (for figures) a label-pair panel. */
function renderUnit(unit: DocUnit, zh: string | undefined): string {
  if (unit.kind === 'figure') {
    const pairs: string[] = []
    const labels = unit.text.split(' · ').filter((label) => label !== '')
    const translated = splitFigureTranslations(unit, zh)
    labels.forEach((label, index) => {
      pairs.push(`<div class="en">${escapeHtml(label)}</div>`)
      pairs.push(`<div class="zh">${escapeHtml(translated[index] ?? '')}</div>`)
    })
    const caption = unit.caption === undefined ? '' : `<h3>图内文字 · ${escapeHtml(unit.caption)}</h3>`
    return `<div class="figure">${caption}<div class="pairs">${pairs.join('')}</div></div>`
  }
  const translated = zh === undefined ? '<span class="tag">未译</span>' : escapeHtml(zh)
  return `<div class="row ${unit.kind}"><div class="src">${escapeHtml(unit.text)}</div><div class="dst">${translated}</div></div>`
}

/**
 * Figure units translate their label list as one text. The model returns one
 * translation per label separated by ` · `, so split it back into pairs.
 */
function splitFigureTranslations(unit: DocUnit, zh: string | undefined): string[] {
  if (zh === undefined) return []
  const parts = zh
    .split(/[·•|\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  const labels = unit.text.split(' · ').filter((label) => label !== '')
  if (parts.length === labels.length) return parts
  return labels.map((_label, index) => parts[index] ?? '')
}

/** Render the Markdown mirror with the same ordering and content. */
export function renderMarkdown(input: RenderInput): string {
  const lines: string[] = []
  lines.push(`# ${input.title} — 双语对照`)
  lines.push('')
  lines.push(
    `> 模型 ${input.model.provider}/${input.model.model} · ${input.document.pageCount} 页 · ${input.generatedAt.toISOString()}`,
  )
  lines.push(`> ${input.itemRef}`)
  lines.push('')
  for (const page of input.document.pages) {
    if (page.units.length === 0) continue
    lines.push(`## Page ${page.page}`)
    for (const unit of page.units) {
      const zh = input.translations.get(unit.id)
      if (unit.kind === 'figure') {
        lines.push('')
        lines.push(`**图内文字${unit.caption === undefined ? '' : `（${unit.caption}）`}**`)
        lines.push('')
        lines.push('| 原文 | 译文 |')
        lines.push('| --- | --- |')
        const labels = unit.text.split(' · ').filter((label) => label !== '')
        const translated = splitFigureTranslations(unit, zh)
        labels.forEach((label, index) => {
          lines.push(`| ${label.replaceAll('|', '\\|')} | ${(translated[index] ?? '').replaceAll('|', '\\|')} |`)
        })
        continue
      }
      lines.push('')
      lines.push(`**${unit.kind === 'heading' ? '## ' : ''}${unit.text}**`)
      if (zh !== undefined) lines.push(zh)
    }
    lines.push('')
  }
  return lines.join('\n')
}

