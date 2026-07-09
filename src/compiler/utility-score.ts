import { recencyDecay } from '../lifecycle/index.js';

/**
 * Phase 8.2 — Utility Score Calculation
 *
 * SSOT §6.4: "Utility score per node: v_i = λ1·decay(Δt) + λ2·causal_centrality
 * + λ3·constraint_priority, with static constants λ1=0.4, λ2=0.4, λ3=0.2 —
 * fixed, not learned, consistent with the whole system's determinism
 * principle."
 *
 * CLAUDE.md non-negotiable constraint: "λ weights are static (0.4/0.4/0.2)
 * — never configurable, never learned." `UTILITY_SCORE_WEIGHTS` below is a
 * fixed, readonly export — not a parameter, not overridable — matching
 * SSOT §9's "kept static and inspectable, by design."
 *
 * Scope note (interpretation choice, documented for review): this phase
 * implements only the weighted-sum combination formula, reusing Phase
 * 3.2's `recencyDecay()` for the `decay(Δt)` term — a real code dependency
 * matching "Depends on: 3.2." `causalCentrality` and `constraintPriority`
 * are taken as pre-computed numeric inputs, not derived here:
 *   - causal_centrality is Phase 8.3's job ("Depends on: 1.6," not 8.2 —
 *     this phase does not depend on 8.3, confirming it must not compute
 *     centrality itself).
 *   - constraint_priority has no dedicated computation phase anywhere in
 *     WORKPLAN's Milestone 8 (only 8.1 token counting, 8.2 this formula,
 *     8.3 centrality, 8.4 packing) and is mentioned exactly once in SSOT
 *     §6.4 with no defined scale or derivation. Treating it as a
 *     caller-supplied number here — rather than guessing its semantics —
 *     keeps this phase's scope exactly what its Build line describes: the
 *     formula itself, not what feeds it.
 */

/** Static, non-configurable weights per SSOT §6.4 / CLAUDE.md. */
export const UTILITY_SCORE_WEIGHTS = {
  decay: 0.4,
  causalCentrality: 0.4,
  constraintPriority: 0.2,
} as const;

export interface UtilityScoreInput {
  /** Node age in seconds (Δt ≥ 0), fed into Phase 3.2's recencyDecay(). */
  deltaTSeconds: number;
  /** Pre-computed causal centrality (Phase 8.3's output) for this node. */
  causalCentrality: number;
  /** Pre-computed constraint priority for this node. */
  constraintPriority: number;
}

/**
 * v_i = λ1·decay(Δt) + λ2·causal_centrality + λ3·constraint_priority
 */
export function calculateUtilityScore(input: UtilityScoreInput): number {
  const decay = recencyDecay(input.deltaTSeconds);
  return (
    UTILITY_SCORE_WEIGHTS.decay * decay +
    UTILITY_SCORE_WEIGHTS.causalCentrality * input.causalCentrality +
    UTILITY_SCORE_WEIGHTS.constraintPriority * input.constraintPriority
  );
}
