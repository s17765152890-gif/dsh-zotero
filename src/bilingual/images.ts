/**
 * Render PDF pages and crop painted figure regions into standalone PNGs.
 * Figures are located by the raster-image rectangles the extractor reports;
 * each crop is padded and clamped to the page, then referenced by the HTML
 * with a relative `figures/` path so the document stays self-contained.
 * @module dsh-zotero/bilingual/images
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
import { getDocumentProxy, renderPageAsImage } from 'unpdf'

/** One figure region to crop, in PDF user units. */
export interface FigureCrop {
  unitId: string
  page: number
  bbox: [number, number, number, number]
  pageWidth: number
  pageHeight: number
}

export interface FigureRenderOptions {
  /** Page render scale (defaults to 1.5). */
  scale?: number
  /** Padding around the figure body in PDF user units (defaults to 24). */
  padding?: number
}

/**
 * Render every page that carries crops once, cut each figure region out, and
 * write `fig-<unitId>.png` files under `figuresDir`.
 * @param pdfPath - the source PDF on disk.
 * @param crops - the figure regions to cut out.
 * @param figuresDir - the directory receiving the PNGs (created as needed).
 * @param options - render scale and padding.
 * @returns unit id → relative `figures/…` path for the HTML.
 */
export async function renderFigureCrops(
  pdfPath: string,
  crops: readonly FigureCrop[],
  figuresDir: string,
  options: FigureRenderOptions = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (crops.length === 0) return out
  const scale = options.scale ?? 1.5
  const padding = options.padding ?? 24
  await mkdir(figuresDir, { recursive: true })
  const data = new Uint8Array(await readFile(pdfPath))
  const doc = await getDocumentProxy(data)
  const byPage = new Map<number, FigureCrop[]>()
  for (const crop of crops) {
    const list = byPage.get(crop.page) ?? []
    list.push(crop)
    byPage.set(crop.page, list)
  }
  for (const [pageNo, pageCrops] of byPage) {
    const first = pageCrops[0]
    if (first === undefined) continue
    const png = await renderPageAsImage(doc, pageNo, {
      canvasImport: () => import('@napi-rs/canvas'),
      scale,
    })
    const image = await loadImage(Buffer.from(png))
    for (const crop of pageCrops) {
      const fileName = `fig-${crop.unitId}.png`
      const cropped = cropRegion(image, crop, first.pageWidth, first.pageHeight, scale, padding)
      if (cropped === undefined) continue
      await writeFile(join(figuresDir, fileName), cropped)
      out.set(crop.unitId, posix.join('figures', fileName))
    }
  }
  return out
}

/** Cut one padded, page-clamped region out of a rendered page. */
function cropRegion(
  image: Image,
  crop: FigureCrop,
  pageWidth: number,
  pageHeight: number,
  scale: number,
  padding: number,
): Buffer | undefined {
  const [x0, y0, x1, y1] = crop.bbox
  const pagePxWidth = Math.round(pageWidth * scale)
  const pagePxHeight = Math.round(pageHeight * scale)
  const pad = Math.round(padding * scale)
  // PDF user units grow upward; PNG rows grow downward.
  const sx = Math.max(0, Math.round(x0 * scale) - pad)
  const sy = Math.max(0, Math.round((pageHeight - y1) * scale) - pad)
  const ex = Math.min(pagePxWidth, Math.round(x1 * scale) + pad)
  const ey = Math.min(pagePxHeight, Math.round((pageHeight - y0) * scale) + pad)
  const width = ex - sx
  const height = ey - sy
  if (width < 10 || height < 10) return undefined
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.drawImage(image, sx, sy, width, height, 0, 0, width, height)
  return canvas.toBuffer('image/png')
}
