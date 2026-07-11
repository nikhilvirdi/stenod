import { describe, it, expect } from 'vitest';
import { packByGreedyRatio } from './greedy-packing.js';
import type { PackableNode } from './greedy-packing.js';
import { applyLocalImprovementPass } from './local-improvement.js';
import { assembleUShapedManifest } from './u-shaped-manifest.js';
import type { UShapedManifest } from './u-shaped-manifest.js';
import { withNextActionsBlock } from './next-actions.js';
import type { RecencyZoneWithNextActions } from './next-actions.js';
import type { FsmState } from '../lifecycle/index.js';

/**
 * Phase 8.8 — Compiler Correctness/Determinism Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Running the compiler twice on identical input produces identical
 *       output
 *
 * Verify line: "run `npm test -- compiler` twice, diff outputs."
 *
 * Scope note (documented for review): this phase's Build line is "comprehensive
 * test suite" — a test-only phase, not a new production orchestrator. Phases
 * 8.4-8.7 each already unit-test their own function in isolation; nothing yet
 * exercises them wired together end-to-end the way SSOT §6.4 actually composes
 * them, and nothing yet proves the composed output is byte-for-byte
 * deterministic (CLAUDE.md's "Determinism" non-negotiable constraint).
 * `compilePipeline()` below is a local test helper, not new production code —
 * it calls only the already-exported Phase 8.4/8.5/8.6/8.7 functions, in
 * SSOT §6.4's documented order, and serializes the result via
 * `JSON.stringify` (deterministic for plain objects/arrays with stable key
 * insertion order, which is exactly what every zone/type here is) so
 * "identical output" can be compared as literal bytes (a string), matching
 * the Done-when wording precisely rather than a looser structural `toEqual`.
 */
describe('compiler/determinism — Phase 8.8', () => {
  type CompiledManifest = UShapedManifest & { recencyZone: RecencyZoneWithNextActions };

  /** Wires the real Phase 8.4 -> 8.5 -> 8.6 -> 8.7 pipeline exactly as SSOT §6.4 describes it. */
  function compilePipeline(
    nodes: PackableNode[],
    tokenBudget: number,
    resumeInstruction: string,
    fsmState: FsmState,
    unresolvedErrorContext?: string
  ): CompiledManifest {
    const packed = packByGreedyRatio(nodes, tokenBudget);
    const improved = applyLocalImprovementPass(packed, tokenBudget);
    const manifest = assembleUShapedManifest(improved, resumeInstruction);
    const recencyZone = withNextActionsBlock(manifest.recencyZone, {
      fsmState,
      unresolvedErrorContext,
    });
    return { ...manifest, recencyZone };
  }

  /** Deterministic serialization of a compiled manifest — the "bytes" compared below. */
  function serialize(manifest: CompiledManifest): string {
    return JSON.stringify(manifest);
  }

  function node(
    id: string,
    utilityScore: number,
    tokenCost: number,
    overrides: Partial<PackableNode> = {}
  ): PackableNode {
    return {
      id,
      type: 'FILE_STATE',
      status: 'ACTIVE',
      utilityScore,
      contentPreview: `content for ${id}`,
      tokenCost,
      ...overrides,
    };
  }

  function constraint(id: string, utilityScore = 1, tokenCost = 5): PackableNode {
    return node(id, utilityScore, tokenCost, { type: 'CONSTRAINT' });
  }

  // ── Fixtures ─────────────────────────────────────────────────────────────

  /** Rich fixture: constraints + a genuine local-improvement swap + an unresolved error. */
  function richFixture(): { nodes: PackableNode[]; budget: number } {
    return {
      nodes: [
        constraint('C1'),
        node('FIRST', 15, 15),
        node('LOWQ', 1, 3),
        node('HIGHQ', 1.5, 5),
        node('REJECTED_NODE', 100, 1, { status: 'REJECTED' }),
        node('SUPERSEDED_NODE', 100, 1, { status: 'SUPERSEDED' }),
      ],
      budget: 20,
    };
  }

  /** Several nodes share equal ratio and equal score, exercising every tie-breaking path. */
  function tieHeavyFixture(): { nodes: PackableNode[]; budget: number } {
    return {
      nodes: [
        constraint('CTA'),
        constraint('CTB'),
        node('T1', 2, 2), // ratio 1.0
        node('T2', 2, 2), // ratio 1.0, same score, tied with T1
        node('T3', 2, 2), // ratio 1.0, same score, tied with T1 and T2
        node('T4', 4, 4), // ratio 1.0, tied ratio, different (higher) score
        node('T5', 4, 4), // ratio 1.0, tied ratio, tied score with T4
      ],
      budget: 6,
    };
  }

  // ── Core Done-when: identical input -> identical bytes ─────────────────────

  it('running the compiled pipeline twice on identical input produces byte-for-byte identical output', () => {
    const { nodes, budget } = richFixture();

    const first = serialize(
      compilePipeline(nodes, budget, 'resume here', 'RUNTIME_ERR', 'build failed with exit code 1')
    );
    const second = serialize(
      compilePipeline(nodes, budget, 'resume here', 'RUNTIME_ERR', 'build failed with exit code 1')
    );

    expect(second).toBe(first);
  });

  it('a tie-heavy fixture (equal ratios and equal scores) is still byte-for-byte deterministic across runs', () => {
    const { nodes, budget } = tieHeavyFixture();

    const runs = Array.from({ length: 5 }, () =>
      serialize(compilePipeline(nodes, budget, 'resume', 'IDE_IDLE'))
    );

    for (const run of runs) {
      expect(run).toBe(runs[0]);
    }
  });

  // ── Table-driven: representative fixtures, each self-consistent across runs ─

  const scenarios: Array<{
    name: string;
    nodes: PackableNode[];
    budget: number;
    resumeInstruction: string;
    fsmState: FsmState;
    unresolvedErrorContext?: string;
  }> = [
    { name: 'empty graph', nodes: [], budget: 100, resumeInstruction: 'nothing to resume', fsmState: 'IDE_IDLE' },
    {
      name: 'constraints only',
      nodes: [constraint('C1'), constraint('C2')],
      budget: 100,
      resumeInstruction: 'resume',
      fsmState: 'IDE_IDLE',
    },
    {
      name: 'no constraints',
      nodes: [node('A', 5, 5), node('B', 3, 5)],
      budget: 100,
      resumeInstruction: 'resume',
      fsmState: 'IDE_IDLE',
    },
    {
      name: 'budget forces exclusion',
      nodes: [node('BIG', 10, 50), node('SMALL', 1, 60)],
      budget: 50,
      resumeInstruction: 'resume',
      fsmState: 'DOC_EDIT',
    },
    {
      name: 'swap-triggering (local improvement fires)',
      nodes: richFixture().nodes,
      budget: richFixture().budget,
      resumeInstruction: 'resume',
      fsmState: 'DIFF_SUBMIT',
    },
    {
      name: 'RUNTIME_ERR with context',
      nodes: [node('A', 5, 5)],
      budget: 100,
      resumeInstruction: 'resume',
      fsmState: 'RUNTIME_ERR',
      unresolvedErrorContext: 'TypeError at src/foo.ts:12',
    },
    {
      name: 'RUNTIME_ERR without context',
      nodes: [node('A', 5, 5)],
      budget: 100,
      resumeInstruction: 'resume',
      fsmState: 'RUNTIME_ERR',
    },
  ];

  it.each(scenarios)(
    'scenario "$name" is byte-for-byte deterministic across repeated runs',
    ({ nodes, budget, resumeInstruction, fsmState, unresolvedErrorContext }) => {
      const runs = Array.from({ length: 3 }, () =>
        serialize(compilePipeline(nodes, budget, resumeInstruction, fsmState, unresolvedErrorContext))
      );

      expect(runs[1]).toBe(runs[0]);
      expect(runs[2]).toBe(runs[0]);
    }
  );

  // ── Correctness sanity checks on the composed pipeline ──────────────────────

  it('non-ACTIVE nodes never appear anywhere in the compiled output', () => {
    const { nodes, budget } = richFixture();

    const manifest = compilePipeline(nodes, budget, 'resume', 'IDE_IDLE');
    const allIds = [...manifest.primacyZone, ...manifest.middleZone].map((n) => n.id);

    expect(allIds).not.toContain('REJECTED_NODE');
    expect(allIds).not.toContain('SUPERSEDED_NODE');
  });

  it('every ACTIVE CONSTRAINT node lands in the primacy zone, and zones appear in U-order', () => {
    const { nodes, budget } = richFixture();

    const manifest = compilePipeline(nodes, budget, 'resume', 'IDE_IDLE');

    expect(manifest.primacyZone.every((n) => n.type === 'CONSTRAINT')).toBe(true);
    expect(manifest.primacyZone.map((n) => n.id)).toContain('C1');
    expect(manifest.middleZone.some((n) => n.type === 'CONSTRAINT')).toBe(false);
    expect(Object.keys(manifest)).toEqual(['primacyZone', 'middleZone', 'recencyZone']);
  });

  it('RUNTIME_ERR fsmState produces a nextActions block; every other state produces none', () => {
    const { nodes, budget } = richFixture();

    const withError = compilePipeline(nodes, budget, 'resume', 'RUNTIME_ERR', 'stack trace here');
    expect(withError.recencyZone.nextActions).toBeDefined();
    expect(withError.recencyZone.nextActions?.message).toContain('stack trace here');

    const withoutError = compilePipeline(nodes, budget, 'resume', 'IDE_IDLE');
    expect(withoutError.recencyZone.nextActions).toBeUndefined();
    expect('nextActions' in withoutError.recencyZone).toBe(false);
  });
});
