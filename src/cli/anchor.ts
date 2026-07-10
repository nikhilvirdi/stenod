import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nextEventId } from '../storage/index.js';
import { redactSecrets } from '../capture/redaction.js';
import { resolveLwwConflict } from '../lifecycle/index.js';
import type { LwwResult } from '../lifecycle/index.js';
import { deriveCurrentFsmState } from './handoff-context.js';

/**
 * Phase 10.6 — `stenod anchor` CONSTRAINT node creation
 *
 * SSOT §5: "stenod anchor \"<text>\" | Create a CONSTRAINT node directly
 * from the CLI." No prior phase actually inserts a CONSTRAINT row — Phase
 * 4.3's comment parser explicitly declines to ("associating extracted
 * constraints with CONSTRAINT nodes is a later phase's job"), and Phase
 * 3.3's `resolveLwwConflict()` explicitly expects the insert to already
 * have happened ("It does not insert the new node itself"). This is that
 * insert path — the first one in the codebase.
 *
 * Constraint key (per explicit user decision, since SSOT's `stenod anchor
 * "<text>"` signature has no key parameter anywhere, yet CONSTRAINT nodes
 * carry a constraint_key that's the entire mechanism behind "Last-Writer-
 * Wins conflict resolution... contradicting constraints are automatically
 * resolved, not both silently injected into a future manifest"): reuse
 * Phase 4.3's exact `key=value` convention (its comment syntax is `//
 * VCS: constraint[key]=value` — the `key=value` part is identical), so
 * `stenod anchor "lang-strictness=always use TypeScript strict mode"`
 * participates in LWW exactly like an auto-detected comment constraint
 * would. Text with no `key=` prefix is still accepted — it just never
 * auto-supersedes anything (constraint_key stays NULL), which is a valid
 * state per the schema's own "nullable" column.
 *
 * Other design decisions (documented for review):
 * -----------------------------------------------------------------------
 * - `content` is redacted via Phase 4.5's `redactSecrets()` before hashing
 *   or storage, matching SSOT §6.2's "content: redacted payload" — a
 *   blanket description of the whole `graph_nodes.content` column, not one
 *   scoped to FILE_STATE rows only.
 * - `id` = SHA-256 of the (redacted) content, matching `id: SHA-256 of
 *   content` and the exact convention Phase 4.4's `writeFileStateNode()`
 *   already established. Anchoring byte-identical text twice therefore
 *   produces the same id; the insert uses `INSERT OR IGNORE` so a repeat
 *   anchor is a safe no-op rather than a primary-key violation — same
 *   rationale as `writeFileStateNode()`'s own id-collision handling.
 * - `fsm_state` is derived via Phase 10.4's `deriveCurrentFsmState()`
 *   (most recent ACTIVE node's fsm_state, defaulting to `IDE_IDLE`) rather
 *   than a hardcoded value — the same "caller-supplied, DB-derived by
 *   whichever orchestrating phase has a connection" pattern already
 *   established for `stenod handoff`.
 * - `source_file` is NULL — a CLI-typed constraint has no originating file.
 */

export interface AnchorResult {
  id: string;
  eventId: number;
  constraintKey: string | undefined;
  content: string;
  created: boolean;
  lww: LwwResult | undefined;
}

const KEY_VALUE_PATTERN = /^([^\s=]+)=(.*)$/;

/**
 * Splits anchor text into an optional constraint key and the remaining
 * content, using the same `key=value` convention Phase 4.3's comment
 * parser recognizes inside `constraint[key]=value`. Text with no leading
 * `key=` (no `=`, or a key containing whitespace) is returned unsplit —
 * the whole string becomes content, key is undefined.
 */
export function parseAnchorText(text: string): { key: string | undefined; content: string } {
  const match = KEY_VALUE_PATTERN.exec(text);
  if (!match) {
    return { key: undefined, content: text };
  }
  return { key: match[1], content: match[2] };
}

/**
 * Creates a CONSTRAINT graph_nodes row from CLI-supplied `text`, resolving
 * any LWW conflict (Phase 3.3) when the text carries a constraint key.
 */
export function anchorConstraint(
  db: Database.Database,
  text: string,
  nowMs: number = Date.now()
): AnchorResult {
  const { key, content } = parseAnchorText(text);
  const redacted = redactSecrets(content);
  const id = createHash('sha256').update(redacted).digest('hex');
  const eventId = nextEventId(db);
  const fsmState = deriveCurrentFsmState(db);

  const info = db
    .prepare(
      `INSERT OR IGNORE INTO graph_nodes
         (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
       VALUES (?, ?, 'CONSTRAINT', ?, ?, ?, 'ACTIVE', NULL, ?)`
    )
    .run(id, eventId, redacted, fsmState, key ?? null, nowMs);

  const created = info.changes > 0;
  const lww = created && key !== undefined ? resolveLwwConflict(db, id, key) : undefined;

  return { id, eventId, constraintKey: key, content: redacted, created, lww };
}
