import type { FsmState } from '../lifecycle/index.js';
import type { RecencyZone } from './u-shaped-manifest.js';

/**
 * Phase 8.7 — "Next Actions" Block
 *
 * SSOT §6.4: recency zone = "exact resume instruction plus the 'Next
 * Actions' block, derived from the FSM's current unresolved state."
 * WORKPLAN Build line: "surface the FSM's current unresolved state (e.g.
 * last unresolved RUNTIME_ERR) as an explicit block in the recency zone."
 *
 * Scope note / interpretation choices (documented for review):
 * -----------------------------------------------------------------------
 * - "Unresolved" is read as: the FSM's *current* state is `RUNTIME_ERR`.
 *   Per Phase 3.1's transition table, `RUNTIME_ERR` is left only by a SAVE
 *   (-> DOC_EDIT, an in-progress fix) or a COMMIT (-> PROVISIONAL_PANIC,
 *   an explicitly-tagged skip) — any state other than RUNTIME_ERR means
 *   there is no currently-open error to surface.
 * - `SessionFsm` (Phase 3.1) tracks only the current state enum, not any
 *   content describing *what* the error was — and this phase depends on
 *   3.1 and 8.6 only, not on storage (1.6) or the capture tracks. So the
 *   descriptive content ("referencing it" per the Done-when checklist) is
 *   taken as an optional caller-supplied `unresolvedErrorContext` string
 *   rather than this phase querying the DB for the triggering
 *   TERMINAL_ERROR/heuristic-crash row itself — that DB lookup, if wanted,
 *   is the caller's job (e.g. a future orchestrating phase that already
 *   has a DB connection), matching the same "caller-supplied opaque
 *   content" pattern already used for Phase 8.2's `constraintPriority` and
 *   Phase 8.6's `resumeInstruction`.
 * - Explicit "decide and document" choice per this phase's own Done-when
 *   wording ("no such block (or a correctly empty one — decide and
 *   document which)"): `generateNextActionsBlock()` returns `undefined`
 *   when there's no unresolved state, not an empty-but-present block
 *   object. Nothing to show means no block, not a placeholder — simpler
 *   for consumers and more semantically honest than a hollow object.
 * - `withNextActionsBlock()` composes this onto Phase 8.6's `RecencyZone`
 *   as a new optional field, via a plain object spread — it does not
 *   modify `u-shaped-manifest.ts` at all, matching the extensibility
 *   `RecencyZone` was specifically designed for in that file's own header
 *   comment.
 */

export interface NextActionsInput {
  fsmState: FsmState;
  /** Descriptive content about the unresolved error, referenced in the block's message when present. */
  unresolvedErrorContext?: string;
}

export interface NextActionsBlock {
  message: string;
}

export interface RecencyZoneWithNextActions extends RecencyZone {
  nextActions?: NextActionsBlock;
}

/**
 * Builds a Next Actions block referencing the FSM's current unresolved
 * error, or `undefined` if there is no unresolved state (fsmState !==
 * 'RUNTIME_ERR').
 */
export function generateNextActionsBlock(input: NextActionsInput): NextActionsBlock | undefined {
  if (input.fsmState !== 'RUNTIME_ERR') {
    return undefined;
  }

  const context = input.unresolvedErrorContext?.trim();
  const message = context
    ? `Unresolved runtime error — investigate and fix before continuing:\n${context}`
    : 'Unresolved runtime error — investigate and fix before continuing.';

  return { message };
}

/**
 * Returns a copy of `recencyZone` with a `nextActions` field attached when
 * there is an unresolved FSM state, otherwise an equivalent copy with no
 * `nextActions` field at all.
 */
export function withNextActionsBlock(
  recencyZone: RecencyZone,
  input: NextActionsInput
): RecencyZoneWithNextActions {
  const nextActions = generateNextActionsBlock(input);
  return nextActions ? { ...recencyZone, nextActions } : { ...recencyZone };
}
