import { describe, it, expect } from 'vitest';
import { recencyDecay } from '../lifecycle/index.js';
import { calculateUtilityScore, UTILITY_SCORE_WEIGHTS } from './utility-score.js';

/**
 * Phase 8.2 — Utility Score Calculation Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Score calculation matches hand-computed expected values on fixture
 *       nodes
 *
 * Verify line: "unit test with hand-calculated expected scores" — every
 * test below states the hand-computed arithmetic in a comment rather than
 * relying on the implementation to compute its own expectation.
 */
describe('compiler/utility-score — Phase 8.2', () => {
  it('static weights match SSOT §6.4 / CLAUDE.md exactly (λ1=0.4, λ2=0.4, λ3=0.2)', () => {
    expect(UTILITY_SCORE_WEIGHTS.decay).toBe(0.4);
    expect(UTILITY_SCORE_WEIGHTS.causalCentrality).toBe(0.4);
    expect(UTILITY_SCORE_WEIGHTS.constraintPriority).toBe(0.2);
  });

  it('a brand-new node (Δt=0, decay=1) with centrality=2, constraint=1: v = 0.4*1 + 0.4*2 + 0.2*1 = 1.4', () => {
    const score = calculateUtilityScore({
      deltaTSeconds: 0,
      causalCentrality: 2,
      constraintPriority: 1,
    });
    expect(score).toBeCloseTo(1.4, 10);
  });

  it('Δt = e-1 gives a clean decay of 0.5 (ln(1+Δt)=ln(e)=1 -> 1/(1+1)=0.5): v = 0.4*0.5 = 0.2', () => {
    const score = calculateUtilityScore({
      deltaTSeconds: Math.E - 1,
      causalCentrality: 0,
      constraintPriority: 0,
    });
    expect(score).toBeCloseTo(0.2, 10);
  });

  it('all-zero centrality/constraint at Δt=0 leaves only the decay term: v = 0.4*1 = 0.4', () => {
    const score = calculateUtilityScore({
      deltaTSeconds: 0,
      causalCentrality: 0,
      constraintPriority: 0,
    });
    expect(score).toBeCloseTo(0.4, 10);
  });

  it('constraint-only contribution at Δt=0: v = 0.4*1 + 0.4*0 + 0.2*5 = 1.4', () => {
    const score = calculateUtilityScore({
      deltaTSeconds: 0,
      causalCentrality: 0,
      constraintPriority: 5,
    });
    expect(score).toBeCloseTo(1.4, 10);
  });

  it('matches an independently hand-assembled formula using the real recencyDecay() for an arbitrary Δt', () => {
    const deltaTSeconds = 100;
    const causalCentrality = 3;
    const constraintPriority = 2;

    const expected =
      0.4 * recencyDecay(deltaTSeconds) + 0.4 * causalCentrality + 0.2 * constraintPriority;

    const score = calculateUtilityScore({ deltaTSeconds, causalCentrality, constraintPriority });

    expect(score).toBeCloseTo(expected, 10);
  });

  it('a negative Δt (clock skew) clamps to 0 via recencyDecay(), matching the Δt=0 score', () => {
    const skewed = calculateUtilityScore({
      deltaTSeconds: -50,
      causalCentrality: 0,
      constraintPriority: 0,
    });
    const atZero = calculateUtilityScore({
      deltaTSeconds: 0,
      causalCentrality: 0,
      constraintPriority: 0,
    });

    expect(skewed).toBeCloseTo(atZero, 10);
    expect(skewed).toBeCloseTo(0.4, 10);
  });
});
