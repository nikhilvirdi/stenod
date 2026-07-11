import { describe, it, expect } from 'vitest';
import { packByGreedyRatio } from './greedy-packing.js';
import type { PackableNode } from './greedy-packing.js';

/**
 * Phase 8.4 — Greedy-by-Ratio Packing Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Constraint nodes always included regardless of score
 *   [x] Non-active nodes never appear in output
 *   [x] Packing respects the token budget exactly (never exceeds it)
 *
 * Verify line: "unit test with a fixture graph including
 * active/rejected/superseded/constraint nodes, confirm correct selection."
 *
 * Fixture (token budget = 50):
 *   C1  CONSTRAINT ACTIVE     score=0.01 cost=20  -> force-included (low score, still in)
 *   C2  CONSTRAINT SUPERSEDED score=999  cost=999 -> dropped (non-ACTIVE, even though CONSTRAINT)
 *   R1  FILE_STATE REJECTED   score=999  cost=1   -> dropped (non-ACTIVE)
 *   A   FILE_STATE ACTIVE     score=9    cost=10  -> ratio 0.9 (packed 1st)
 *   E   FILE_STATE ACTIVE     score=4    cost=10  -> ratio 0.4 (packed 2nd)
 *   B   FILE_STATE ACTIVE     score=2    cost=20  -> ratio 0.1 (doesn't fit after A+E; skipped)
 *   F   FILE_STATE ACTIVE     score=0.5  cost=10  -> ratio 0.05 (fits in what B couldn't; packed 3rd)
 *
 * After C1 (cost 20), remaining budget = 30. Greedy order by ratio:
 * A(0.9) -> fits, remaining 20. E(0.4) -> fits, remaining 10.
 * B(0.1) -> cost 20 > remaining 10 -> skipped (not stopped-at). F(0.05) ->
 * cost 10 == remaining 10 -> fits exactly. Total = 20+10+10+10 = 50 = budget.
 */
describe('compiler/greedy-packing — Phase 8.4', () => {
  const C1: PackableNode = {
    id: 'C1',
    type: 'CONSTRAINT',
    status: 'ACTIVE',
    utilityScore: 0.01,
    contentPreview: 'always use TypeScript strict mode',
    tokenCost: 20,
  };
  const C2: PackableNode = {
    id: 'C2',
    type: 'CONSTRAINT',
    status: 'SUPERSEDED',
    utilityScore: 999,
    contentPreview: 'stale superseded constraint, should never appear',
    tokenCost: 999,
  };
  const R1: PackableNode = {
    id: 'R1',
    type: 'FILE_STATE',
    status: 'REJECTED',
    utilityScore: 999,
    contentPreview: 'an old rejected file state, should never appear',
    tokenCost: 1,
  };
  const A: PackableNode = {
    id: 'A',
    type: 'FILE_STATE',
    status: 'ACTIVE',
    utilityScore: 9,
    contentPreview: 'export function add(a: number, b: number): number { return a + b; }',
    tokenCost: 10,
  };
  const E: PackableNode = {
    id: 'E',
    type: 'FILE_STATE',
    status: 'ACTIVE',
    utilityScore: 4,
    contentPreview: 'npm test passed',
    tokenCost: 10,
  };
  const B: PackableNode = {
    id: 'B',
    type: 'FILE_STATE',
    status: 'ACTIVE',
    utilityScore: 2,
    contentPreview: 'FILE_STATE in src/b.ts',
    tokenCost: 20,
  };
  const F: PackableNode = {
    id: 'F',
    type: 'FILE_STATE',
    status: 'ACTIVE',
    utilityScore: 0.5,
    contentPreview: 'FILE_STATE in src/f.ts',
    tokenCost: 10,
  };

  const fixture: PackableNode[] = [C1, C2, R1, A, E, B, F];
  const BUDGET = 50;

  it('constraint nodes are always included regardless of score', () => {
    const result = packByGreedyRatio(fixture, BUDGET);
    expect(result.included.some((n) => n.id === 'C1')).toBe(true);
  });

  it('non-active nodes (SUPERSEDED constraint, REJECTED node) never appear in included or excluded', () => {
    const result = packByGreedyRatio(fixture, BUDGET);
    const allOutputIds = [...result.included, ...result.excluded].map((n) => n.id);

    expect(allOutputIds).not.toContain('C2');
    expect(allOutputIds).not.toContain('R1');
  });

  it('packing respects the token budget exactly — never exceeds it, and hits it exactly on this fixture', () => {
    const result = packByGreedyRatio(fixture, BUDGET);

    expect(result.totalTokens).toBeLessThanOrEqual(BUDGET);
    expect(result.totalTokens).toBe(50);
  });

  it('selects the exact expected set, in the expected order, via the greedy-by-ratio + continue-scanning rule', () => {
    const result = packByGreedyRatio(fixture, BUDGET);

    expect(result.included.map((n) => n.id)).toEqual(['C1', 'A', 'E', 'F']);
    expect(result.excluded.map((n) => n.id)).toEqual(['B']);
  });

  it('a node with tokenCost=0 sorts as infinite ratio and is packed first among non-constraint nodes', () => {
    const zeroCost: PackableNode = {
      id: 'Z',
      type: 'FILE_STATE',
      status: 'ACTIVE',
      utilityScore: 0,
      contentPreview: '',
      tokenCost: 0,
    };
    const result = packByGreedyRatio([zeroCost, A, E, B, F], BUDGET);

    // Z has ratio Infinity (not NaN despite 0/0), so it's packed before A
    // (ratio 0.9), the next-highest.
    expect(result.included[0]?.id).toBe('Z');
    expect(result.included[1]?.id).toBe('A');
  });

  it('is deterministic: identical input produces identical output across repeated calls', () => {
    const first = packByGreedyRatio(fixture, BUDGET);
    const second = packByGreedyRatio(fixture, BUDGET);

    expect(second.included.map((n) => n.id)).toEqual(first.included.map((n) => n.id));
    expect(second.excluded.map((n) => n.id)).toEqual(first.excluded.map((n) => n.id));
    expect(second.totalTokens).toBe(first.totalTokens);
  });

  it('an empty node list with any budget produces an empty, zero-token result', () => {
    const result = packByGreedyRatio([], 100);

    expect(result.included).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it('a zero token budget with no constraints excludes every candidate node', () => {
    const result = packByGreedyRatio([A, E, B, F], 0);

    expect(result.included).toEqual([]);
    expect(result.totalTokens).toBe(0);
    expect(result.excluded.map((n) => n.id)).toEqual(['A', 'E', 'B', 'F']);
  });
});
