/**
 * Tool-mapped and pure-logic specs for the bilingual reader: JSON answer
 * parsing, prompt label resolution, output-path layout, and the rendered
 * document shape. Mocks stop at the LLM stream boundary; no host, HTTP, or
 * PDF bytes involved.
 * @module tests/tools/bilingual/document
 */

import { describe, expect, it } from 'vitest'
import { outputRootFor, sanitizeSegment } from '../../../src/bilingual/paths.js'
import { renderHtml, renderMarkdown } from '../../../src/bilingual/render.js'
import { parseTranslations } from '../../../src/bilingual/translate.js'
import { targetLanguageLabel } from '../../../src/bilingual/types.js'
import type { ExtractedDocument } from '../../../src/bilingual/extract.js'

const DOCUMENT: ExtractedDocument = {
  pageCount: 1,
  pages: [
    {
      page: 1,
      units: [
        { id: 'p1-h0', kind: 'heading', page: 1, text: 'Cut Off by the Tide' },
        { id: 'p1-b1', kind: 'paragraph', page: 1, text: 'People get cut off by the flooding tide.' },
        {
          id: 'p1-c2',
          kind: 'caption',
          page: 1,
          text: 'Figure 1. Ways people get cut off',
        },
        {
          id: 'p1-f3',
          kind: 'figure',
          page: 1,
          text: 'Causeway · Sandflat',
          caption: 'Figure 1. Ways people get cut off',
        },
      ],
    },
  ],
  figureFragments: 2,
  hasText: true,
}

describe('parseTranslations', () => {
  it('maps ids from a clean JSON array', () => {
    const map = parseTranslations('[{"id": "p1-b1", "zh": "人们被上涨的潮水围困。"}]')
    expect(map.get('p1-b1')).toBe('人们被上涨的潮水围困。')
  })

  it('tolerates fences and prose around the array', () => {
    const map = parseTranslations('here you go:\n```json\n[{"id":"a","zh":"甲"}]\n```')
    expect(map.get('a')).toBe('甲')
  })

  it('rejects answers without any usable entries', () => {
    expect(() => parseTranslations('no json here')).toThrow()
    expect(() => parseTranslations('[{"id":"a","zh":""}]')).toThrow()
  })
})

describe('targetLanguageLabel', () => {
  it('resolves zh-CN and passes unknown tags through', () => {
    expect(targetLanguageLabel('zh-CN')).toBe('Simplified Chinese')
    expect(targetLanguageLabel('xx-yy')).toBe('xx-yy')
  })
})

describe('output paths', () => {
  it('keeps one folder per item key and scrubs separators', async () => {
    const { join } = await import('node:path')
    expect(outputRootFor('/out', 'ABC123')).toBe(join('/out', 'ABC123'))
    expect(sanitizeSegment('../../x')).toBe('.._.._x')
    expect(sanitizeSegment('')).toBe('item')
  })
})

describe('rendered document', () => {
  const translations = new Map([
    ['p1-h0', '被潮水切断'],
    ['p1-b1', '人们被上涨的潮水围困。'],
    ['p1-c2', '图 1. 人们被围困的方式'],
    ['p1-f3', '堤道 · 沙滩'],
  ])
  const input = {
    document: DOCUMENT,
    translations,
    title: 'Cut Off by the Tide',
    itemRef: 'zotero://user/0/item/ABC123',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    targetLang: 'Simplified Chinese',
    sourceLang: 'English',
    generatedAt: new Date('2026-11-05T00:00:00Z'),
  }

  it('renders side-by-side rows and a figure pair panel', () => {
    const html = renderHtml(input)
    expect(html).toContain('Causeway')
    expect(html).toContain('堤道')
    expect(html).toContain('Figure 1')
    expect(html).toContain('图 1')
  })

  it('mirrors the same pairs in Markdown', () => {
    const markdown = renderMarkdown(input)
    expect(markdown).toContain('| 原文 | 译文 |')
    expect(markdown).toContain('Causeway')
    expect(markdown).toContain('堤道')
  })
})
