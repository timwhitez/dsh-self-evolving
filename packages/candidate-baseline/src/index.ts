/**
 * @dsh-self-evolving/candidate-baseline — stable baseline parent candidate.
 *
 * This is the root of the RSI lineage: a minimal, mechanism-free namespace-form
 * DSH bundle that every generated candidate descends from. It exists so that:
 *
 *  - Gate 0 can prove a real Cordis Loader boots/unloads a candidate bundle with
 *    exact inventory equality and no leaked effect (spec 07 §2).
 *  - every child has a canonical parent (spec 02 §1) for diff/identity accounting.
 *
 * It does NOT solve tasks better than the unmodified runner: it contributes a
 * stable, candidate-scoped prompt section and registers no tools. Behavior change
 * is reserved for generated descendants.
 *
 * Form contract (spec 02 §4): namespace-form named exports only. Do NOT add
 * `export default apply` — the DSH Loader's default-unwrap drops sibling
 * `inject`/`Config`/`name` metadata, and only a real Loader test catches it
 * (postmortem 0001). The negative fixture in dsh-self-evolving-loader-e2e enforces this.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
// Type-only import of the prompt surface so `ctx.systemPrompt` resolves. At
// runtime the host provides the service; the candidate never bundles it.
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'self-evolving-candidate'

/**
 * Required DSH services. A candidate waits for these before its Fiber activates,
 * and is disposed/reloaded if any disappears. The baseline needs the prompt
 * surface only; tools are optional and queried at use time.
 */
export const inject = ['systemPrompt']

export type CandidateMode = 'solve' | 'propose'

export interface Config {
  /** Immutable candidate identity assigned by the trusted builder (full sha256). */
  candidateId: string
  /** Behavior branch selected by TCB config, never by the candidate itself. */
  mode: CandidateMode
}

export const Config: Schema<Config> = Schema.object({
  candidateId: Schema.string().required(),
  mode: Schema.union(['solve', 'propose'] as const).required(),
})

export function apply(ctx: Context, config: Config): void {
  // Candidate behavior MUST be owned by the candidate Fiber and unwind on unload.
  // The baseline contributes a single stable prompt section (KV-prefix friendly:
  // stable text across turns). It registers no timers, tools, listeners, or
  // external resources — so quiescence after unload is trivially exact and any
  // future leak is attributable to a descendant, not to scaffolding noise.
  ctx.systemPrompt.section({
    name: 'candidate:baseline',
    order: 100,
    text:
      config.mode === 'solve'
        ? // solve mode: the candidate sees only the ordinary task instruction.
          // No search metadata, scores, split labels, verifier source, or controller.
          'You are solving a Terminal-Bench task. Use the provided tools directly. ' +
          'Do not assume any special scoring or evaluator behavior.'
        : // propose mode: the candidate extends the proposer agent that generates
          // the next generation. Baseline contributes only a neutral stance.
          'You are proposing a minimal, falsifiable improvement to the harness. ' +
          'Prefer mechanism-level hypotheses over prompt decoration.',
  })
}
