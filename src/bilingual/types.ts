/**
 * Shared types for the bilingual reader: the harness LLM service surface and
 * the model selection the translator runs on.
 * @module dsh-zotero/bilingual/types
 */

export type { LlmRuntime } from '@deepseek-ai/dsh-llm'
export type { ModelSelection } from '@deepseek-ai/dsh-agent'

/** Human-readable target language labels for the translation prompt. */
export const TARGET_LANGUAGE_LABELS: Record<string, string> = {
  zh: 'Simplified Chinese',
  'zh-cn': 'Simplified Chinese',
  'zh-hans': 'Simplified Chinese',
  'zh-tw': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
}

/** Resolve a BCP-47-ish language tag to the prompt label; unknown tags pass through. */
export function targetLanguageLabel(tag: string): string {
  return TARGET_LANGUAGE_LABELS[tag.toLowerCase()] ?? tag
}
