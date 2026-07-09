import { SessionFsm } from './fsm.js';

/**
 * Phase 3.5 — Anti-Rot Timeout Logic
 *
 * SSOT §6.3:
 *   "Anti-rot: FSM stuck in RUNTIME_ERR for τ > 600s → seal the active tree,
 *    apply decay."
 *
 * Definition of "Sealing the active tree":
 *   The current error-recovery cycle is forcefully abandoned by resetting the
 *   FSM state to IDE_IDLE. No database records are deleted or explicitly
 *   marked REJECTED here — they remain ACTIVE in the graph but will naturally
 *   lose utility score over time via the recency decay function (Phase 3.2).
 *   This ensures the system doesn't permanently halt on an abandoned error.
 *
 * Implementation:
 *   A stateful timer that watches the FSM. Starts a 600s countdown when entering
 *   RUNTIME_ERR, clears it when exiting. If the timeout triggers, resets the FSM
 *   and invokes a caller-provided callback.
 */
export class AntiRotTimer {
  private timer: NodeJS.Timeout | null = null;
  public readonly thresholdMs = 600_000; // 600 seconds

  constructor(
    private readonly fsm: SessionFsm,
    private readonly onSeal: () => void,
  ) {}

  /**
   * Must be called after every event applied to the FSM.
   */
  public onTransition(): void {
    this.clear();

    if (this.fsm.state === 'RUNTIME_ERR') {
      this.timer = setTimeout(() => {
        this.seal();
      }, this.thresholdMs);

      // In a real daemon, we don't want this timer alone to prevent the process
      // from exiting if it's otherwise ready to shut down.
      this.timer.unref?.();
    }
  }

  private seal(): void {
    // 1. Reset FSM to IDE_IDLE (the "seal")
    // Note on SSOT §6.3 "apply decay": This requirement is satisfied implicitly.
    // By resetting the FSM, we abandon the error cycle. The nodes from this cycle
    // stay ACTIVE, and their Δt grows unboundedly from their created_at. When
    // Phase 8.2 calculates their utility score, recencyDecay() will naturally
    // yield a lower score. No active decay write happens here, and none is needed.
    this.fsm.reset();

    // 2. Clear timer state explicitly
    this.timer = null;

    // 3. Notify the daemon
    this.onSeal();
  }

  /**
   * Clears the timer. Must be called during daemon shutdown to prevent leaks.
   */
  public clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
