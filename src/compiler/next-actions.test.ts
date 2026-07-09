import { describe, it, expect } from 'vitest';
import { FSM_STATES } from '../lifecycle/index.js';
import type { FsmState } from '../lifecycle/index.js';
import { generateNextActionsBlock, withNextActionsBlock } from './next-actions.js';
import type { RecencyZone } from './u-shaped-manifest.js';

/**
 * Phase 8.7 — "Next Actions" Block Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] A fixture with an unresolved error correctly produces a Next
 *       Actions block referencing it
 *   [x] A fixture with no unresolved state produces no such block (or a
 *       correctly empty one — decide and document which)
 *
 * Verify line: "unit test for both cases."
 */
describe('compiler/next-actions — Phase 8.7', () => {
  it('an unresolved error (fsmState=RUNTIME_ERR) with context produces a block referencing that context', () => {
    const block = generateNextActionsBlock({
      fsmState: 'RUNTIME_ERR',
      unresolvedErrorContext: 'TypeError: cannot read property "x" of undefined at src/foo.ts:12',
    });

    expect(block).toBeDefined();
    expect(block?.message).toContain(
      'TypeError: cannot read property "x" of undefined at src/foo.ts:12'
    );
  });

  it('an unresolved error with no context still produces a generic block (RUNTIME_ERR is itself the ground truth)', () => {
    const block = generateNextActionsBlock({ fsmState: 'RUNTIME_ERR' });

    expect(block).toBeDefined();
    expect(block?.message.length).toBeGreaterThan(0);
  });

  it('every non-RUNTIME_ERR FSM state produces no block at all (undefined, not an empty object) — table-driven over all FSM_STATES', () => {
    const nonErrorStates = FSM_STATES.filter((state) => state !== 'RUNTIME_ERR');
    expect(nonErrorStates.length).toBeGreaterThan(0);

    for (const fsmState of nonErrorStates as FsmState[]) {
      const block = generateNextActionsBlock({
        fsmState,
        unresolvedErrorContext: 'some content that should be ignored',
      });
      expect(block, `expected undefined for fsmState=${fsmState}`).toBeUndefined();
    }
  });

  it('withNextActionsBlock attaches nextActions to the recency zone when there is an unresolved error', () => {
    const recencyZone: RecencyZone = { resumeInstruction: 'pick up where you left off' };

    const result = withNextActionsBlock(recencyZone, {
      fsmState: 'RUNTIME_ERR',
      unresolvedErrorContext: 'build failed with exit code 1',
    });

    expect(result.resumeInstruction).toBe('pick up where you left off');
    expect(result.nextActions).toBeDefined();
    expect(result.nextActions?.message).toContain('build failed with exit code 1');
  });

  it('withNextActionsBlock leaves the recency zone without a nextActions field when there is no unresolved state', () => {
    const recencyZone: RecencyZone = { resumeInstruction: 'pick up where you left off' };

    const result = withNextActionsBlock(recencyZone, { fsmState: 'IDE_IDLE' });

    expect(result.resumeInstruction).toBe('pick up where you left off');
    expect(result.nextActions).toBeUndefined();
    expect('nextActions' in result).toBe(false);
  });
});
