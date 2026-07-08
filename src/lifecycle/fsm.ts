/**
 * Phase 3.1 — FSM State Enum + Transitions
 *
 * SSOT §6.3:
 *   "FSM: IDE_IDLE → RUNTIME_ERR (stderr/nonzero exit) → DOC_EDIT (save)
 *    → DIFF_SUBMIT (commit). A direct RUNTIME_ERR → DIFF_SUBMIT skip is
 *    tagged PROVISIONAL_PANIC, excluded from manifests unless explicitly
 *    anchored."
 *
 *   "PROVIDER_CAPTURE nodes are stored as content but do NOT drive FSM
 *    transitions — transitions stay driven exclusively by terminal exit codes
 *    and file saves, the two unambiguous ground-truth signals."
 *
 * Design decisions (documented for review):
 * ------------------------------------------
 *
 * EVENTS:
 *   Three event types drive the FSM — ERROR, SAVE, COMMIT — corresponding
 *   exactly to the three ground-truth signals the SSOT names: stderr/nonzero
 *   exit, file save, and git commit. There is deliberately no PROVIDER_CAPTURE
 *   event. If a caller tries to pass one (via a type assertion that defeats
 *   TypeScript's compile-time check), the transition function throws at runtime.
 *
 * TRANSITION TABLE (15 cells — every state×event pair is defined):
 *   The SSOT defines the primary cycle:
 *     IDE_IDLE → RUNTIME_ERR → DOC_EDIT → DIFF_SUBMIT
 *   plus the panic skip:
 *     RUNTIME_ERR + COMMIT → PROVISIONAL_PANIC
 *
 *   For state×event pairs the SSOT does not explicitly mention, the following
 *   principles are applied:
 *     - Same-signal-while-already-in-state is a no-op (e.g. ERROR while
 *       already in RUNTIME_ERR stays in RUNTIME_ERR, SAVE while already in
 *       DOC_EDIT stays in DOC_EDIT).
 *     - SAVE and COMMIT from IDE_IDLE are normal workflow events (editing and
 *       committing without an error triggering the cycle), so the FSM stays
 *       in IDE_IDLE — these are not part of an error-recovery cycle.
 *     - ERROR from DOC_EDIT means a new error interrupted the fix attempt,
 *       so the FSM moves to RUNTIME_ERR (new error cycle).
 *     - DIFF_SUBMIT and PROVISIONAL_PANIC are cycle-terminal states. An ERROR
 *       from either starts a new cycle (→ RUNTIME_ERR). SAVE or COMMIT from
 *       either resets to IDE_IDLE (the cycle is over, normal work continues).
 *
 * PURE LOGIC, NO I/O:
 *   This module contains no database calls, no filesystem access, no terminal
 *   interaction. It is a pure state machine testable in complete isolation.
 *   Wiring it into capture and storage is the responsibility of Phases 4.x
 *   and 5.x.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * All valid FSM states. Exported as a const tuple so tests and callers can
 * enumerate them at runtime (e.g. for table-driven tests).
 */
export const FSM_STATES = [
  'IDE_IDLE',
  'RUNTIME_ERR',
  'DOC_EDIT',
  'DIFF_SUBMIT',
  'PROVISIONAL_PANIC',
] as const;

export type FsmState = (typeof FSM_STATES)[number];

/**
 * Events that drive FSM transitions. Exactly three signals, all from
 * unambiguous ground-truth sources (SSOT §6.3):
 *   - ERROR: stderr output or nonzero exit code from a terminal command
 *   - SAVE: file saved to disk
 *   - COMMIT: git commit (diff submitted)
 *
 * PROVIDER_CAPTURE is deliberately absent — SSOT §6.3 explicitly states
 * that provider capture nodes do NOT drive FSM transitions.
 */
export const FSM_EVENTS = ['ERROR', 'SAVE', 'COMMIT'] as const;

export type FsmEvent = (typeof FSM_EVENTS)[number];

/** Result returned by every transition call. */
export interface TransitionResult {
  /** State before the transition. */
  readonly from: FsmState;
  /** State after the transition. */
  readonly to: FsmState;
  /** Event that triggered the transition. */
  readonly event: FsmEvent;
  /** True if the state actually changed (from !== to). */
  readonly changed: boolean;
}

// ── Transition table ────────────────────────────────────────────────────────

/**
 * Complete transition table: every (state, event) pair maps to a target state.
 *
 * The table is a plain object, not a Map, so it's inspectable in tests and
 * serializable for debugging. Every cell is populated — there are no
 * undefined entries. See the module-level comment for the rationale behind
 * each non-obvious cell.
 */
export const TRANSITION_TABLE: Readonly<
  Record<FsmState, Readonly<Record<FsmEvent, FsmState>>>
> = {
  // ── Primary cycle ────────────────────────────────────────────────
  IDE_IDLE: {
    ERROR: 'RUNTIME_ERR', // error detected → start error-recovery cycle
    SAVE: 'IDE_IDLE', // normal editing, not part of error cycle
    COMMIT: 'IDE_IDLE', // normal commit, not part of error cycle
  },

  RUNTIME_ERR: {
    ERROR: 'RUNTIME_ERR', // another error while already in error state
    SAVE: 'DOC_EDIT', // editing in response to error
    COMMIT: 'PROVISIONAL_PANIC', // ← THE PANIC SKIP: commit without editing
  },

  DOC_EDIT: {
    ERROR: 'RUNTIME_ERR', // new error interrupted the fix attempt
    SAVE: 'DOC_EDIT', // continued editing
    COMMIT: 'DIFF_SUBMIT', // deliberate fix committed
  },

  // ── Cycle-terminal states (reset on next event) ──────────────────
  DIFF_SUBMIT: {
    ERROR: 'RUNTIME_ERR', // new error after commit → new cycle
    SAVE: 'IDE_IDLE', // post-commit editing → back to idle
    COMMIT: 'IDE_IDLE', // another commit → back to idle
  },

  PROVISIONAL_PANIC: {
    ERROR: 'RUNTIME_ERR', // new error after panic commit → new cycle
    SAVE: 'IDE_IDLE', // post-panic editing → back to idle
    COMMIT: 'IDE_IDLE', // another commit → back to idle
  },
};

// ── Runtime validation ──────────────────────────────────────────────────────

function isValidState(state: string): state is FsmState {
  return (FSM_STATES as readonly string[]).includes(state);
}

function isValidEvent(event: string): event is FsmEvent {
  return (FSM_EVENTS as readonly string[]).includes(event);
}

// ── Pure transition function ────────────────────────────────────────────────

/**
 * Pure, stateless transition function. Given the current state and an event,
 * returns the full TransitionResult including the target state and whether
 * the state changed.
 *
 * Throws on invalid state or event values (runtime guard for callers that
 * bypass TypeScript's compile-time type checking via type assertions or
 * `any` casts).
 */
export function transition(state: FsmState, event: FsmEvent): TransitionResult {
  // Runtime guards — TypeScript's type system prevents bad values at compile
  // time, but callers integrating from less-typed code (or using `as any`)
  // should still get a clear error rather than an undefined lookup.
  if (!isValidState(state as string)) {
    throw new Error(
      `stenod FSM: invalid state "${state}". ` +
        `Valid states: ${FSM_STATES.join(', ')}`,
    );
  }
  if (!isValidEvent(event as string)) {
    throw new Error(
      `stenod FSM: invalid event "${event}". ` +
        `Valid events: ${FSM_EVENTS.join(', ')}. ` +
        `Note: PROVIDER_CAPTURE does not drive FSM transitions (SSOT §6.3).`,
    );
  }

  const to = TRANSITION_TABLE[state][event];
  return {
    from: state,
    to,
    event,
    changed: state !== to,
  };
}

// ── Stateful wrapper ────────────────────────────────────────────────────────

/**
 * Mutable FSM wrapper. Holds the current state and exposes a transition()
 * method that advances the state in place. Used by the daemon's main loop;
 * the pure `transition()` function above is for isolated testing and callers
 * that manage state externally.
 */
export class SessionFsm {
  private _state: FsmState;

  constructor(initialState: FsmState = 'IDE_IDLE') {
    this._state = initialState;
  }

  /** The current FSM state. */
  get state(): FsmState {
    return this._state;
  }

  /**
   * Apply an event, update the internal state, and return the full
   * TransitionResult. Delegates to the pure `transition()` function.
   */
  apply(event: FsmEvent): TransitionResult {
    const result = transition(this._state, event);
    this._state = result.to;
    return result;
  }

  /** Reset the FSM to IDE_IDLE. */
  reset(): void {
    this._state = 'IDE_IDLE';
  }
}
