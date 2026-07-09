import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionFsm } from './fsm.js';
import { AntiRotTimer } from './anti-rot.js';

/**
 * Phase 3.5 — Anti-Rot Timeout Tests
 *
 * SSOT §6.3:
 *   "Anti-rot: FSM stuck in RUNTIME_ERR for τ > 600s → seal the active tree,
 *    apply decay."
 *
 * Coverage:
 *   1. Timeout does not trigger before 600s.
 *   2. Timeout correctly triggers exactly at 600s.
 *   3. "Sealing" behavior resets FSM to IDE_IDLE and invokes callback.
 *   4. Transitioning out of RUNTIME_ERR before 600s clears the timer.
 *   5. Timer is not started in non-RUNTIME_ERR states.
 */

describe('Anti-Rot Timeout — Phase 3.5', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('timer does not start in IDE_IDLE', () => {
    const fsm = new SessionFsm();
    const onSeal = vi.fn();
    const antiRot = new AntiRotTimer(fsm, onSeal);

    // Explicitly transition, but remain in IDLE
    fsm.apply('SAVE');
    antiRot.onTransition();

    vi.advanceTimersByTime(600_000);

    expect(onSeal).not.toHaveBeenCalled();
    expect(fsm.state).toBe('IDE_IDLE');
  });

  it('triggers exactly at 600s, not before', () => {
    const fsm = new SessionFsm();
    const onSeal = vi.fn();
    const antiRot = new AntiRotTimer(fsm, onSeal);

    // Move to RUNTIME_ERR
    fsm.apply('ERROR');
    antiRot.onTransition();

    // Advance to 599.999 seconds
    vi.advanceTimersByTime(599_999);
    expect(onSeal).not.toHaveBeenCalled();
    expect(fsm.state).toBe('RUNTIME_ERR');

    // Advance the final millisecond to hit exactly 600s
    vi.advanceTimersByTime(1);
    
    // Sealing behavior is triggered: callback invoked, FSM reset
    expect(onSeal).toHaveBeenCalledTimes(1);
    expect(fsm.state).toBe('IDE_IDLE'); // This is the defined "sealing" behavior
  });

  it('transitioning out of RUNTIME_ERR clears the timer', () => {
    const fsm = new SessionFsm();
    const onSeal = vi.fn();
    const antiRot = new AntiRotTimer(fsm, onSeal);

    // Move to RUNTIME_ERR
    fsm.apply('ERROR');
    antiRot.onTransition();

    // Wait 300s (halfway)
    vi.advanceTimersByTime(300_000);

    // Transition to DOC_EDIT (e.g. user saves a file)
    fsm.apply('SAVE');
    antiRot.onTransition(); // This should clear the timer since we are no longer in RUNTIME_ERR
    
    expect(fsm.state).toBe('DOC_EDIT');

    // Advance way past the original 600s boundary
    vi.advanceTimersByTime(400_000);

    // Should NOT have triggered
    expect(onSeal).not.toHaveBeenCalled();
    expect(fsm.state).toBe('DOC_EDIT');
  });

  it('subsequent errors while in RUNTIME_ERR reset the 600s timer', () => {
    const fsm = new SessionFsm();
    const onSeal = vi.fn();
    const antiRot = new AntiRotTimer(fsm, onSeal);

    // Move to RUNTIME_ERR
    fsm.apply('ERROR');
    antiRot.onTransition();

    // Wait 500s
    vi.advanceTimersByTime(500_000);

    // Another ERROR happens (re-enters/stays in RUNTIME_ERR)
    fsm.apply('ERROR');
    antiRot.onTransition(); // Clears old timer, starts a fresh 600s one

    // Wait another 500s (total elapsed = 1000s)
    vi.advanceTimersByTime(500_000);

    // First timer was cancelled, second hasn't hit 600s yet
    expect(onSeal).not.toHaveBeenCalled();
    expect(fsm.state).toBe('RUNTIME_ERR');

    // Wait the remaining 100s of the second timer
    vi.advanceTimersByTime(100_000);

    expect(onSeal).toHaveBeenCalledTimes(1);
    expect(fsm.state).toBe('IDE_IDLE');
  });
});
