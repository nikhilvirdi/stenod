/**
 * Phase 5.4 — Long-Running Process Stderr Heuristic
 *
 * SSOT §6.1: "Long-running processes that never exit within a session
 * (dev servers, docker compose up) are additionally watched for stderr
 * matching common crash shapes (Error:, Traceback, panic:, unhandled
 * rejection patterns) as an explicitly-labeled best-effort secondary
 * signal, since exit-code detection doesn't apply to them."
 *
 * Per the confirmed scope decision: this heuristic does NOT drive the FSM.
 * fsm.ts documents SSOT §6.3 as "transitions stay driven exclusively by
 * terminal exit codes and file saves, the two unambiguous ground-truth
 * signals" — a pattern-matched line is explicitly a best-effort guess, not
 * one of those two, so it only produces a node, snapshotting (not
 * advancing) the FSM's current state.
 *
 * Distinguishing mechanism: graph_nodes.type is a locked CHECK-constrained
 * enum (Phase 1.2: FILE_STATE, TERMINAL_ERROR, TERMINAL_SUCCESS,
 * PROVIDER_CAPTURE, CONSTRAINT) — adding a 6th value like "HEURISTIC_ERROR"
 * would mean altering an already-Verified schema, out of this phase's
 * scope. So this still writes type='TERMINAL_ERROR', and the distinguishing
 * label lives in `content` via a fixed, greppable prefix — exactly what
 * SSOT means by "explicitly-labeled".
 *
 * "stderr" caveat: node-pty (Phase 5.1) exposes one merged PTY data stream
 * — there is no separate stdout/stderr channel at this layer (a PTY
 * inherently merges both). This heuristic scans the same combined output
 * stream Phase 5.3 already batches, not a stderr-only feed. A real,
 * disclosed limitation, not a silent deviation from spec.
 *
 * Phase 5.5 addition: content is redacted via the same redactSecrets() pass
 * Phase 4.5 applies to filesystem content, before the HEURISTIC_CRASH_TAG
 * prefix is added or the content is hashed/stored — this is terminal
 * content reaching graph_nodes.content just as much as writeTerminalNode's
 * is. The tag itself is a fixed marker, not user content, so it is
 * prepended after redaction rather than redacted itself.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { SessionFsm, FsmState } from '../lifecycle/index.js';
import type { TerminalWriteResult } from './terminal-state.js';
import { redactSecrets } from './redaction.js';

/** Prefixed onto content so a heuristic-detected node is greppable/visually distinct from a real exit-code TERMINAL_ERROR. */
export const HEURISTIC_CRASH_TAG = '[heuristic:stderr-crash] ';

/**
 * Crash-shaped patterns named explicitly in SSOT §6.1. The three
 * conventionally-capitalized markers are matched case-sensitively (that is
 * their real-world literal form); "unhandled rejection" is matched
 * case-insensitively since SSOT names it as a pattern *family*
 * ("...patterns"), and Node's own wording for this varies.
 */
const CRASH_PATTERNS: readonly RegExp[] = [
  /\bError:/,
  /\bTraceback\b/,
  /\bpanic:/,
  /unhandled(?:\s+promise)?\s*rejection/i,
];

/** True if `chunk` contains any of SSOT §6.1's named crash-shaped patterns. */
export function looksLikeCrash(chunk: string): boolean {
  return CRASH_PATTERNS.some((pattern) => pattern.test(chunk));
}

/** Same monotonic event_id strategy as file-state.ts/terminal-state.ts — see file-state.ts's doc comment. */
function nextEventId(db: Database.Database): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(event_id), 0) + 1 AS next FROM graph_nodes')
    .get() as { next: number };
  return row.next;
}

/**
 * Writes one heuristic-tagged TERMINAL_ERROR graph_nodes row. Does NOT call
 * fsm.apply() — fsm_state is a snapshot of the FSM's current (unchanged)
 * state, per the confirmed scope decision that this best-effort signal
 * must not move the one piece of state the rest of the system treats as
 * ground truth.
 *
 * Same SHA-256-of-content id + INSERT OR IGNORE collision handling as
 * writeTerminalNode()/writeFileStateNode(), for the same reason (avoid
 * resurrecting a REJECTED/SUPERSEDED node via a content-hash collision).
 */
export function writeHeuristicCrashNode(
  db: Database.Database,
  fsm: SessionFsm,
  content: string,
): TerminalWriteResult {
  const taggedContent = HEURISTIC_CRASH_TAG + redactSecrets(content);
  const fsmState: FsmState = fsm.state;
  const id = createHash('sha256').update(taggedContent).digest('hex');
  const eventId = nextEventId(db);

  const info = db
    .prepare(
      `INSERT OR IGNORE INTO graph_nodes
         (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
       VALUES (?, ?, 'TERMINAL_ERROR', ?, ?, NULL, 'ACTIVE', NULL, ?)`,
    )
    .run(id, eventId, taggedContent, fsmState, Date.now());

  return { id, eventId, type: 'TERMINAL_ERROR', fsmState, created: info.changes > 0 };
}
