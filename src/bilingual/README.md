# bilingual reader

Production scope: PDF → bilingual document. `src/bilingual/extract.ts`
(geometry-first text layout into paragraphs, headings, captions, and
figure-label fragments), `translate.ts` (batched harness-LLM translation with
resume cache), `render.ts` (side-by-side HTML plus a Markdown mirror),
`document.ts` (orchestration: extract → translate → render), `paths.ts`
(output layout), `types.ts` (LLM/model-selection aliases shared by the
module). The model-facing surface is `src/tools/bilingual-document.ts`
(`zotero_bilingual_document`).

The module never writes the Zotero library: it resolves the attachment path
through the provider's existing `attachments` capability, then works on the
local PDF bytes.

## Test locations

- Tool behaviour and input validation: `tests/tools/bilingual/` (tool mapping
  plus a representative execution path with a scripted transport).
- Pure units (`parseTranslations`, language labels, output-path layout,
  figure-label heuristics): the same specs, direct calls, no host, no HTTP.
- LLM call shape and layout contracts: real validators and rendered strings,
  not rebuilt algorithms; mocks stop at the `llm.stream` boundary.
- Live Zotero and live model runs: not in the suite. Phase acceptance is a
  real `zotero_bilingual_document` call on a short paper after installing the
  fork in the DSH profile (see `docs/scenarios.md` pack W).
