/**
 * Minimal LLM runtime stand-in so compositions that mount ZoteroService can
 * satisfy its `llm` injection: the bilingual document tool reads `ctx.llm`,
 * and Cordis refuses the undeclared service without a provider. Translation
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
