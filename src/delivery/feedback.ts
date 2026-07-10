import type Database from 'better-sqlite3';
import type { ManifestOutcome } from '../storage/index.js';

/**
 * Phase 9.3 — Feedback Tagging
 *
 * SSOT §6.5, §4: "Feedback tagging (--worked / --failed) — the only
 * mechanism for ever having real data to justify tuning retrieval weights
 * later." WORKPLAN Build line: "--worked/--failed updates the outcome
 * column on the most recent manifest_log row."
 *
 * Design decisions (documented for review):
 * -----------------------------------------------------------------------
 * - This function takes `outcome: ManifestOutcome` directly (already
 *   exported by Phase 1.4's schema module) rather than parsing `--worked`
 *   / `--failed` CLI flags itself — that flag-to-outcome mapping is CLI
 *   wiring, explicitly Phase 10.4's job ("Wire `stenod handoff`
 *   (+worked/failed)," which depends on 9.3, confirming the dependency
 *   runs implementation-before-wiring, not the reverse). Matches the same
 *   scope boundary already used by every other 9.x phase (pure functions,
 *   no CLI parsing until Milestone 10).
 * - **"Most recent" row selection**: `manifest_log` has no monotonic
 *   sequence column analogous to `graph_nodes.event_id` (Phase 8.9's own
 *   determinism fix used exactly that column), and the schema's own header
 *   comment ("Do NOT add columns beyond this list," manifest-log.ts) rules
 *   out adding one here. `created_at` (epoch ms) alone can tie if two
 *   handoffs occur within the same millisecond. The query explicitly
 *   orders by `created_at DESC, rowid DESC` — SQLite's implicit rowid
 *   (present on this table since its PK is TEXT, not `INTEGER PRIMARY
 *   KEY`) is guaranteed to increase with insertion order, giving a
 *   deterministic, explicitly-named tie-break with no schema change. This
 *   is the same "always name an explicit, tie-free ORDER BY" principle
 *   Phase 8.9 established, applied to the one deterministic column this
 *   table actually has available.
 * - An empty `manifest_log` (no handoff has ever run) is a no-op —
 *   returns `{ updated: false }` rather than throwing. No spec ambiguity
 *   here: "updates the outcome column on the most recent row" has nothing
 *   to update when no row exists, matching the same not-found-is-a-no-op
 *   pattern already used elsewhere in this codebase (e.g. Phase 3.3's
 *   `resolveLwwConflict` when no conflicting row exists).
 * - Calling this again (re-tagging) simply overwrites the same row's
 *   `outcome` with the new value — "the most recent row" is evaluated
 *   fresh on every call, not cached from a prior call.
 */

export interface TagManifestOutcomeResult {
  /** Whether a row was found and updated. False only when manifest_log is empty. */
  updated: boolean;
  /** The id of the updated row, present only when `updated` is true. */
  id?: string;
}

/**
 * Updates the `outcome` column of the most recent `manifest_log` row to
 * `outcome` ('WORKED' or 'FAILED'). Every other row is left untouched.
 * No-op (returns `{ updated: false }`) if `manifest_log` has no rows.
 */
export function tagManifestOutcome(
  db: Database.Database,
  outcome: ManifestOutcome
): TagManifestOutcomeResult {
  const mostRecent = db
    .prepare('SELECT id FROM manifest_log ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get() as { id: string } | undefined;

  if (!mostRecent) {
    return { updated: false };
  }

  db.prepare('UPDATE manifest_log SET outcome = ? WHERE id = ?').run(outcome, mostRecent.id);

  return { updated: true, id: mostRecent.id };
}
