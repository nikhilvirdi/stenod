import type Database from 'better-sqlite3';
import type { FsmState } from '../lifecycle/index.js';

/**
 * Phase 10.4 — `stenod handoff` DB-derived context
 *
 * `compileManifest()` (Phase 8.9) takes `fsmState`/`unresolvedErrorContext`
 * as opaque, caller-supplied parameters — deliberately, per that phase's
 * own header comment: "deriving 'current FSM state' from the DB would be
 * new, unspecified behavior this phase wasn't asked to add... the DB
 * lookup, if wanted, is the caller's job (e.g. a future orchestrating phase
 * that already has a DB connection)." Phase 10.4 is that orchestrating
 * phase. Both values below are derived directly from `graph_nodes`, the
 * same table every capture track already tags with `fsm_state` on write
 * (Phase 4.4: "FSM state association (`DOC_EDIT` on save)").
 */

interface FsmStateRow {
  fsm_state: FsmState;
}

/**
 * The FSM state associated with the most recently created ACTIVE node
 * (`ORDER BY event_id DESC` — the same monotonic, tie-free column Phase
 * 8.9 itself uses for deterministic ordering), or `'IDE_IDLE'` — the same
 * default `SessionFsm` (Phase 3.1) initializes to — if no ACTIVE node
 * exists yet (e.g. a freshly-initialized project with no captured events).
 */
export function deriveCurrentFsmState(db: Database.Database): FsmState {
  const row = db
    .prepare(
      `SELECT fsm_state FROM graph_nodes WHERE status = 'ACTIVE' ORDER BY event_id DESC LIMIT 1`
    )
    .get() as FsmStateRow | undefined;

  return row?.fsm_state ?? 'IDE_IDLE';
}

interface ContentRow {
  content: string;
}

/**
 * Content of the most recent ACTIVE `TERMINAL_ERROR` node — the "last
 * unresolved RUNTIME_ERR" Phase 8.7's own Build line references as the
 * Next Actions block's descriptive content — or `undefined` if there isn't
 * one. Only meaningful when the current FSM state is `RUNTIME_ERR`; callers
 * are expected to gate on that themselves, matching `next-actions.ts`'s own
 * `generateNextActionsBlock()`, which already ignores
 * `unresolvedErrorContext` for any other state.
 */
export function deriveUnresolvedErrorContext(db: Database.Database): string | undefined {
  const row = db
    .prepare(
      `SELECT content FROM graph_nodes
       WHERE status = 'ACTIVE' AND type = 'TERMINAL_ERROR'
       ORDER BY event_id DESC LIMIT 1`
    )
    .get() as ContentRow | undefined;

  return row?.content;
}
