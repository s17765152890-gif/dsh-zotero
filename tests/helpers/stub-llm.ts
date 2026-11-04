/**
 * Minimal LLM runtime stand-in: the bilingual tool reads `ctx.llm`, so every
 * composition that mounts ZoteroService provides the service name. Translation
 * itself never streams through these specs.
 * @module tests/helpers/stub-llm
 */

import { Context, Service } from '@deepseek-ai/cordis'

/** The `llm` service name the plugin's bilingual path requires. */
export class StubLlm extends Service {
  constructor(llmCtx: Context) {
    super(llmCtx, 'llm')
  }
}

/**
 * The `agentDefaultModel` service name the bilingual tool requires to resolve
 * the session's model route. `currentSelection` stays undefined here so every
 * spec observes the "no configured route" path without a model ever
 * streaming.
 */
export class StubDefaultModel extends Service {
  constructor(defaultCtx: Context) {
    super(defaultCtx, 'agentDefaultModel')
  }

  currentSelection(): undefined {
    return undefined
  }
}
