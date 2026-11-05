/**
 * Output paths for bilingual documents: one folder per Zotero item key under
 * the configured output root. The folder is stable so re-running a translation
 * reuses the cache and rewrites the same HTML/Markdown.
 * @module dsh-zotero/bilingual/paths
 */

import { join } from 'node:path'

/** Paths to the artifacts of one bilingual document. */
export interface BilingualPaths {
  /** Per-item output directory. */
  dir: string
  /** Cropped figure PNGs live here; the HTML references them relatively. */
  figuresDir: string
  htmlPath: string
  markdownPath: string
  cachePath: string
}

/** The per-item directory under the output root. */
export function outputRootFor(root: string, itemKey: string): string {
  return join(root, sanitizeSegment(itemKey))
}

/** Compose the artifact paths inside one per-item directory. */
export function composeOutputPaths(dir: string): BilingualPaths {
  return {
    dir,
    figuresDir: join(dir, 'figures'),
    htmlPath: join(dir, 'index.html'),
    markdownPath: join(dir, 'bilingual.md'),
    cachePath: join(dir, 'translation.json'),
  }
}

/** Keep one path segment free of separators and Windows-reserved characters. */
export function sanitizeSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) || 'item'
}
