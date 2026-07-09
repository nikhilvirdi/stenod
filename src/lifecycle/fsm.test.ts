import { describe, it, expect } from 'vitest';
import {
  FSM_STATES,
  FSM_EVENTS,
  transition,
  SessionFsm,
} from './fsm.js';
import type { FsmState, FsmEvent } from './fsm.js';

/**
 * Phase 3.1 — FSM State Enum + Transitions Tests
 *
 * SSOT §6.3: IDE_IDLE → RUNTIME_ERR → DOC_EDIT → DIFF_SUBMIT, with the
 * panic skip RUNTIME_ERR → DIFF_SUBMIT tagged PROVISIONAL_PANIC.
 * PROVIDER_CAPTURE does NOT drive transitions.
 *
 * Coverage:
 *   1.  Table-driven: all 15 state×event pairs match expected targets
 *   2.  Panic skip: RUNTIME_ERR + COMMIT → PROVISIONAL_PANIC, not DIFF_SUBMIT
 *   3.  Normal commit: DOC_EDIT + COMMIT → DIFF_SUBMIT (contrast with panic)
 *   4.  PROVIDER_CAPTURE is not a valid FsmEvent — rejected at runtime
 *   5.  Unknown event string is rejected at runtime
 *   6.  Unknown state string is rejected at runtime
 *   7.  SessionFsm starts in IDE_IDLE by default
 *   8.  SessionFsm: full deliberate fix cycle
 *   9.  SessionFsm: panic cycle (RUNTIME_ERR → PROVISIONAL_PANIC)
 *  10.  SessionFsm.reset() returns to IDE_IDLE from any state
 *  11.  TransitionResult.changed is true when state changes
 *  12.  TransitionResult.changed is false when state stays the same
 *  13.  Cycle-terminal states (DIFF_SUBMIT, PROVISIONAL_PANIC) reset on next event
 */

describe('FSM state transitions — Phase 3.1', () => {
  // ── Table-driven: complete transition coverage ────────────────────────────

  it('all 15 state×event pairs produce the correct target state', () => {
    // This is the complete, authoritative expected transition table.
    // Every cell is verified, not just the "interesting" ones.
    const expected: Array<[FsmState, FsmEvent, FsmState]> = [
      // IDE_IDLE
      ['IDE_IDLE', 'ERROR', 'RUNTIME_ERR'],
      ['IDE_IDLE', 'SAVE', 'IDE_IDLE'],
      ['IDE_IDLE', 'COMMIT', 'IDE_IDLE'],

      // RUNTIME_ERR
      ['RUNTIME_ERR', 'ERROR', 'RUNTIME_ERR'],
      ['RUNTIME_ERR', 'SAVE', 'DOC_EDIT'],
      ['RUNTIME_ERR', 'COMMIT', 'PROVISIONAL_PANIC'], // ← panic skip

      // DOC_EDIT
      ['DOC_EDIT', 'ERROR', 'RUNTIME_ERR'],
      ['DOC_EDIT', 'SAVE', 'DOC_EDIT'],
      ['DOC_EDIT', 'COMMIT', 'DIFF_SUBMIT'],

      // DIFF_SUBMIT
      ['DIFF_SUBMIT', 'ERROR', 'RUNTIME_ERR'],
      ['DIFF_SUBMIT', 'SAVE', 'IDE_IDLE'],
      ['DIFF_SUBMIT', 'COMMIT', 'IDE_IDLE'],

      // PROVISIONAL_PANIC
      ['PROVISIONAL_PANIC', 'ERROR', 'RUNTIME_ERR'],
      ['PROVISIONAL_PANIC', 'SAVE', 'IDE_IDLE'],
      ['PROVISIONAL_PANIC', 'COMMIT', 'IDE_IDLE'],
    ];

    // Verify we are testing every combination, not accidentally missing one.
    expect(expected.length).toBe(FSM_STATES.length * FSM_EVENTS.length);

    for (const [from, event, expectedTo] of expected) {
      const result = transition(from, event);
      expect(result.to, `transition(${from}, ${event})`).toBe(expectedTo);
      expect(result.from).toBe(from);
      expect(result.event).toBe(event);
    }
  });

  // ── Panic skip (the phase's critical case) ────────────────────────────────

  it('RUNTIME_ERR + COMMIT → PROVISIONAL_PANIC, not DIFF_SUBMIT', () => {
    const result = transition('RUNTIME_ERR', 'COMMIT');
    expect(result.to).toBe('PROVISIONAL_PANIC');
    expect(result.to).not.toBe('DIFF_SUBMIT');
    expect(result.changed).toBe(true);
  });

  it('DOC_EDIT + COMMIT → DIFF_SUBMIT (the non-panic deliberate path)', () => {
    const result = transition('DOC_EDIT', 'COMMIT');
    expect(result.to).toBe('DIFF_SUBMIT');
    expect(result.to).not.toBe('PROVISIONAL_PANIC');
    expect(result.changed).toBe(true);
  });

  // ── PROVIDER_CAPTURE non-transition (SSOT §6.3 explicit requirement) ──────

  it('PROVIDER_CAPTURE is not a valid FsmEvent and is rejected at runtime', () => {
    // PROVIDER_CAPTURE is deliberately excluded from FsmEvent (SSOT §6.3).
    // A caller bypassing TypeScript's type system should still get a clear error.
    expect(() => {
      transition('IDE_IDLE', 'PROVIDER_CAPTURE' as FsmEvent);
    }).toThrow(/invalid event.*PROVIDER_CAPTURE/i);

    // The error message should mention that PROVIDER_CAPTURE doesn't drive transitions.
    try {
      transition('RUNTIME_ERR', 'PROVIDER_CAPTURE' as FsmEvent);
    } catch (err) {
      expect((err as Error).message).toContain('PROVIDER_CAPTURE');
      expect((err as Error).message).toContain('SSOT');
    }
  });

  // ── Unknown/invalid inputs ────────────────────────────────────────────────

  it('unknown event string is rejected at runtime', () => {
    expect(() => {
      transition('IDE_IDLE', 'EXPLODE' as FsmEvent);
    }).toThrow(/invalid event/i);
  });

  it('unknown state string is rejected at runtime', () => {
    expect(() => {
      transition('NONEXISTENT' as FsmState, 'ERROR');
    }).toThrow(/invalid state/i);
  });

  // ── SessionFsm class ─────────────────────────────────────────────────────

  it('SessionFsm starts in IDE_IDLE by default', () => {
    const fsm = new SessionFsm();
    expect(fsm.state).toBe('IDE_IDLE');
  });

  it('SessionFsm: full deliberate fix cycle (IDLE → ERR → EDIT → SUBMIT → IDLE)', () => {
    const fsm = new SessionFsm();

    const r1 = fsm.apply('ERROR');
    expect(r1.to).toBe('RUNTIME_ERR');
    expect(fsm.state).toBe('RUNTIME_ERR');

    const r2 = fsm.apply('SAVE');
    expect(r2.to).toBe('DOC_EDIT');
    expect(fsm.state).toBe('DOC_EDIT');

    const r3 = fsm.apply('COMMIT');
    expect(r3.to).toBe('DIFF_SUBMIT');
    expect(fsm.state).toBe('DIFF_SUBMIT');

    // After the cycle-terminal state, a normal event resets to IDLE.
    const r4 = fsm.apply('SAVE');
    expect(r4.to).toBe('IDE_IDLE');
    expect(fsm.state).toBe('IDE_IDLE');
  });

  it('SessionFsm: panic cycle (IDLE → ERR → PROVISIONAL_PANIC → IDLE)', () => {
    const fsm = new SessionFsm();

    fsm.apply('ERROR');
    expect(fsm.state).toBe('RUNTIME_ERR');

    // Commit directly from RUNTIME_ERR without editing → PROVISIONAL_PANIC
    const panic = fsm.apply('COMMIT');
    expect(panic.to).toBe('PROVISIONAL_PANIC');
    expect(panic.from).toBe('RUNTIME_ERR');
    expect(fsm.state).toBe('PROVISIONAL_PANIC');

    // Next event resets the cycle.
    fsm.apply('SAVE');
    expect(fsm.state).toBe('IDE_IDLE');
  });

  it('SessionFsm.reset() returns to IDE_IDLE from any state', () => {
    const fsm = new SessionFsm();

    // Move to RUNTIME_ERR, then reset.
    fsm.apply('ERROR');
    expect(fsm.state).toBe('RUNTIME_ERR');
    fsm.reset();
    expect(fsm.state).toBe('IDE_IDLE');

    // Move deeper, then reset.
    fsm.apply('ERROR');
    fsm.apply('SAVE');
    expect(fsm.state).toBe('DOC_EDIT');
    fsm.reset();
    expect(fsm.state).toBe('IDE_IDLE');
  });

  // ── TransitionResult correctness ──────────────────────────────────────────

  it('TransitionResult.changed is true when state changes', () => {
    const result = transition('IDE_IDLE', 'ERROR');
    expect(result.changed).toBe(true);
    expect(result.from).toBe('IDE_IDLE');
    expect(result.to).toBe('RUNTIME_ERR');
    expect(result.event).toBe('ERROR');
  });

  it('TransitionResult.changed is false when state stays the same', () => {
    // ERROR from RUNTIME_ERR stays in RUNTIME_ERR.
    const r1 = transition('RUNTIME_ERR', 'ERROR');
    expect(r1.changed).toBe(false);
    expect(r1.from).toBe('RUNTIME_ERR');
    expect(r1.to).toBe('RUNTIME_ERR');

    // SAVE from IDE_IDLE stays in IDE_IDLE.
    const r2 = transition('IDE_IDLE', 'SAVE');
    expect(r2.changed).toBe(false);
  });

  // ── Cycle-terminal state reset behaviour ──────────────────────────────────

  it('DIFF_SUBMIT and PROVISIONAL_PANIC both reset on next event', () => {
    // DIFF_SUBMIT resets to IDE_IDLE on SAVE and COMMIT.
    expect(transition('DIFF_SUBMIT', 'SAVE').to).toBe('IDE_IDLE');
    expect(transition('DIFF_SUBMIT', 'COMMIT').to).toBe('IDE_IDLE');
    // ... but ERROR starts a new cycle.
    expect(transition('DIFF_SUBMIT', 'ERROR').to).toBe('RUNTIME_ERR');

    // Same for PROVISIONAL_PANIC.
    expect(transition('PROVISIONAL_PANIC', 'SAVE').to).toBe('IDE_IDLE');
    expect(transition('PROVISIONAL_PANIC', 'COMMIT').to).toBe('IDE_IDLE');
    expect(transition('PROVISIONAL_PANIC', 'ERROR').to).toBe('RUNTIME_ERR');
  });
});
