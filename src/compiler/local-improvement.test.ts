import { describe, it, expect } from 'vitest';
import { packByGreedyRatio } from './greedy-packing.js';
import type { PackableNode, GreedyPackResult } from './greedy-packing.js';
import { applyLocalImprovementPass } from './local-improvement.js';

/**
 * Phase 8.5 — Local Improvement Pass Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] A constructed fixture where greedy-alone is suboptimal is
 *       correctly improved by this pass
 *   [x] Pass terminates (no infinite loop) on all test fixtures
 *
 * Verify line: "unit test with a deliberately constructed
 * suboptimal-greedy scenario."
 */
describe('compiler/local-improvement — Phase 8.5', () => {
  function node(id: string, utilityScore: number, tokenCost: number): PackableNode {
    return {
      id,
      type: 'FILE_STATE',
      status: 'ACTIVE',
      utilityScore,
      contentPreview: `content for ${id}`,
      tokenCost,
    };
  }

  // ── End-to-end: a deliberately suboptimal-for-greedy fixture ────────────
  //
  // Budget = 20.
  //   FIRST : cost=15, value=15 -> ratio=1.0    (highest ratio, greedy picks it first)
  //   LOWQ  : cost=3,  value=1  -> ratio=0.333  (fits in the remaining 5, greedy picks it: remaining=2)
  //   HIGHQ : cost=5,  value=1.5 -> ratio=0.3   (lower ratio than LOWQ -> checked last, remaining=2,
  //                                              cost 5 > 2 -> excluded by pure greedy)
  //
  // Pure greedy: included=[FIRST,LOWQ], value=15+1=16, cost=18 (2 tokens of budget wasted).
  // But swapping LOWQ (value 1, cost 3) for HIGHQ (value 1.5, cost 5) fits exactly in the
  // budget freed by removing LOWQ (20-(18-3)=5, and HIGHQ's cost is exactly 5) and strictly
  // improves value (1.5 > 1) -> the local improvement pass must find and apply this swap.

  it('a deliberately suboptimal-for-greedy fixture is correctly improved by the local improvement pass', () => {
    const FIRST = node('FIRST', 15, 15);
    const LOWQ = node('LOWQ', 1, 3);
    const HIGHQ = node('HIGHQ', 1.5, 5);
    const BUDGET = 20;

    const greedyOnly = packByGreedyRatio([FIRST, LOWQ, HIGHQ], BUDGET);

    // Confirm the fixture is genuinely suboptimal for plain greedy before improving it.
    expect(greedyOnly.included.map((n) => n.id)).toEqual(['FIRST', 'LOWQ']);
    expect(greedyOnly.excluded.map((n) => n.id)).toEqual(['HIGHQ']);
    const greedyOnlyValue = greedyOnly.included.reduce((sum, n) => sum + n.utilityScore, 0);
    expect(greedyOnlyValue).toBeCloseTo(16, 10);

    const improved = applyLocalImprovementPass(greedyOnly, BUDGET);

    expect(improved.included.map((n) => n.id)).toEqual(['FIRST', 'HIGHQ']);
    expect(improved.excluded.map((n) => n.id)).toEqual(['LOWQ']);
    expect(improved.totalTokens).toBe(20);
    expect(improved.totalTokens).toBeLessThanOrEqual(BUDGET);
    expect(improved.swapCount).toBe(1);

    const improvedValue = improved.included.reduce((sum, n) => sum + n.utilityScore, 0);
    expect(improvedValue).toBeCloseTo(16.5, 10);
    expect(improvedValue).toBeGreaterThan(greedyOnlyValue);

    // Running the pass again on its own (already-improved) output finds nothing left to do.
    const again = applyLocalImprovementPass(improved, BUDGET);
    expect(again.swapCount).toBe(0);
    expect(again.included.map((n) => n.id)).toEqual(['FIRST', 'HIGHQ']);
  });

  // ── Isolated unit tests against a hand-built GreedyPackResult ───────────

  it('CONSTRAINT nodes are never swapped out, even when they have the lowest score in the set', () => {
    const C = {
      id: 'C',
      type: 'CONSTRAINT',
      status: 'ACTIVE',
      utilityScore: 0.01,
      contentPreview: 'content for C',
      tokenCost: 5,
    } as const;
    const A = node('A', 10, 5);
    const Z = node('Z', 100, 5);
    const input: GreedyPackResult = { included: [C, A], excluded: [Z], totalTokens: 10 };

    const result = applyLocalImprovementPass(input, 10);

    expect(result.included.some((n) => n.id === 'C')).toBe(true);
    expect(result.included.some((n) => n.id === 'Z')).toBe(true);
    expect(result.excluded.some((n) => n.id === 'A')).toBe(true);
    expect(result.swapCount).toBe(1);
  });

  it('multiple successive improving swaps are all applied, and total value strictly increases each time', () => {
    const L1 = node('L1', 1, 2);
    const L2 = node('L2', 2, 3);
    const H1 = node('H1', 5, 2);
    const H2 = node('H2', 10, 3);
    const input: GreedyPackResult = {
      included: [L1, L2],
      excluded: [H1, H2],
      totalTokens: 5,
    };

    const result = applyLocalImprovementPass(input, 5);

    expect(result.swapCount).toBe(2);
    expect(result.included.map((n) => n.id).sort()).toEqual(['H1', 'H2']);
    expect(result.excluded.map((n) => n.id).sort()).toEqual(['L1', 'L2']);
    expect(result.totalTokens).toBe(5);

    const finalValue = result.included.reduce((sum, n) => sum + n.utilityScore, 0);
    const originalValue = input.included.reduce((sum, n) => sum + n.utilityScore, 0);
    expect(finalValue).toBe(15);
    expect(finalValue).toBeGreaterThan(originalValue);
  });

  it('when no excluded node improves on the lowest included node, the pass is a no-op', () => {
    const A = node('A', 10, 5);
    const B = node('B', 1, 1); // lower value than A, so swapping would NOT improve
    const input: GreedyPackResult = { included: [A], excluded: [B], totalTokens: 5 };

    const result = applyLocalImprovementPass(input, 10);

    expect(result.swapCount).toBe(0);
    expect(result.included).toEqual([A]);
    expect(result.excluded).toEqual([B]);
    expect(result.totalTokens).toBe(5);
  });

  it('terminates (does not hang) on an empty node set', () => {
    const input: GreedyPackResult = { included: [], excluded: [], totalTokens: 0 };

    const result = applyLocalImprovementPass(input, 100);

    expect(result.swapCount).toBe(0);
    expect(result.included).toEqual([]);
  });

  it('terminates (does not hang) when included contains only CONSTRAINT nodes', () => {
    const C = {
      id: 'C',
      type: 'CONSTRAINT',
      status: 'ACTIVE',
      utilityScore: 0,
      contentPreview: 'content for C',
      tokenCost: 5,
    } as const;
    const input: GreedyPackResult = {
      included: [C],
      excluded: [node('Z', 100, 1)],
      totalTokens: 5,
    };

    const result = applyLocalImprovementPass(input, 10);

    expect(result.swapCount).toBe(0);
    expect(result.included).toEqual([C]);
  });
});
