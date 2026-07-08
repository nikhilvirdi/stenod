/**
 * Phase 3.2 — Recency Decay Function (fixed formula)
 *
 * SSOT §6.3:
 *   "Recency decay (bug found and fixed during design review): original
 *    formula 1/ln(1+Δt) is undefined at Δt=0 (new node → ln(1)=0 →
 *    division by zero). Corrected:
 *      decay(Δt) = 1 / (1 + ln(1 + Δt_seconds))
 *    Monotonic, no singularity, decay(0) = 1."
 *
 * Properties of this formula:
 *   - decay(0) = 1 / (1 + ln(1 + 0)) = 1 / (1 + ln(1)) = 1 / (1 + 0) = 1
 *   - Monotonically decreasing for Δt > 0 (denominator strictly increases)
 *   - Always positive (denominator > 0 for all Δt ≥ 0)
 *   - Approaches 0 as Δt → ∞ (but never reaches it)
 *
 * This is a pure function with no I/O, no dependencies, no state.
 */

/**
 * Computes the recency decay weight for a node whose age is `deltaSeconds`.
 *
 * @param deltaSeconds — Age of the node in seconds (Δt ≥ 0).
 *   Must be non-negative. Negative values are clamped to 0 as a defensive
 *   measure (clock skew can produce small negative deltas in practice).
 *
 * @returns A value in (0, 1] where 1 means "brand new" and values approaching
 *   0 mean "very old". The value is deterministic for a given input.
 */
export function recencyDecay(deltaSeconds: number): number {
  // Defensive clamp: negative Δt (e.g. from clock skew) is treated as 0.
  const dt = Math.max(0, deltaSeconds);

  // decay(Δt) = 1 / (1 + ln(1 + Δt))
  return 1 / (1 + Math.log(1 + dt));
}
