/**
 * Phase 4.4 — `FILE_STATE` Node Creation
 *
 * SSOT §6.2, §6.3: wires filesystem save events into `graph_nodes` writes
 * (`FILE_STATE` type), including FSM state association driven by the
 * Phase 3.1 transition table (a SAVE event does not always land on
 * DOC_EDIT — e.g. from IDE_IDLE a SAVE stays IDE_IDLE; only from
 * RUNTIME_ERR does SAVE transition to DOC_EDIT).
 *
 * Scope note: per the confirmed scope decision, this phase does not invoke
 * the Phase 4.2 AST parser — "Depends on: 4.2" in WORKPLAN is a build-order
 * dependency, not one this file calls into.
 *
 * Does NOT wire file deletions (chokidar's `unlink` event) — the Build
 * line for this phase only describes save events ("DOC_EDIT on save").
 *
 * Phase 4.5 update: content is now passed through redactSecrets() before
 * it is hashed or stored, so graph_nodes.content actually is the "redacted
 * payload" SSOT §6.2 describes, and `id` (SHA-256 "of content") is computed
 * from that same redacted string — the id matches what's actually stored.
 *
 * Phase 7.2 addition: createFileStateCapture() now accepts an optional
 * `queue` (Phase 6.1/6.2's IngestionQueue) as a 4th parameter. When
 * provided, the save-event write is routed through
 * `queue.enqueueOverflowable()` instead of calling writeFileStateNode()
 * inline — the single shared write path SSOT §6.1 describes ("all tracks
 * feed one serialized queue"), completing the wiring 6.1's own header
 * comment deferred to this phase. `queue` is optional and the parameter is
 * purely additive: every existing call site that omits it keeps the exact
 * original inline-write behavior, so this is non-breaking for Phase 4.4's
 * already-Verified callers/tests.
 */

import type Database from 'better-sqlite3';
import { nextEventId } from '../storage/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FSWatcher } from 'chokidar';
import { createWatcher } from './watcher.js';
import { redactSecrets } from './redaction.js';
import type { IngestionQueue } from './queue.js';
import type { SessionFsm, FsmState } from '../lifecycle/index.js';

export interface FileStateWriteResult {
  /** SHA-256 hex digest of `content` (SSOT §6.2: graph_nodes.id). */
  id: string;
  eventId: number;
  fsmState: FsmState;
  /**
   * False when a node with this exact content hash already existed and the
   * write was a no-op (see the id-collision note on writeFileStateNode).
   */
  created: boolean;
}

/**
 * Writes one FILE_STATE graph_nodes row for a file-save event and advances
 * `fsm` with the SAVE event, using the resulting state as the node's
 * fsm_state.
 *
 * id-collision handling: SSOT §6.2 defines graph_nodes.id as "SHA-256 of
 * content", so saving byte-identical content twice (e.g. an editor's no-op
 * save, or two files with identical content) produces the same id. Rather
 * than let that throw a primary-key violation, the insert uses
 * `INSERT OR IGNORE`: the existing row (and its status/fsm_state/
 * created_at) is left untouched, and `created: false` is returned. This is
 * a deliberate choice, not a named SSOT requirement — the alternative
 * (INSERT OR REPLACE) could silently resurrect a REJECTED or SUPERSEDED
 * node just because its content reappeared, which would fight Phase 3.3's
 * LWW and 3.4's rejection semantics. The FSM still transitions on every
 * call regardless of whether a new row was written — a save is a real
 * signal from the editor even if the resulting content happens to match an
 * existing node.
 */
export function writeFileStateNode(
  db: Database.Database,
  fsm: SessionFsm,
  filePath: string,
  content: string,
): FileStateWriteResult {
  const redacted = redactSecrets(content);
  const id = createHash('sha256').update(redacted).digest('hex');
  const { to: fsmState } = fsm.apply('SAVE');
  const eventId = nextEventId(db);

  const info = db
    .prepare(
      `INSERT OR IGNORE INTO graph_nodes
         (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
       VALUES (?, ?, 'FILE_STATE', ?, ?, NULL, 'ACTIVE', ?, ?)`,
    )
    .run(id, eventId, redacted, fsmState, filePath, Date.now());

  return { id, eventId, fsmState, created: info.changes > 0 };
}

/**
 * Starts a Phase 4.1 chokidar watcher over `projectRoot` and wires its
 * onChange callback (add/change) to writeFileStateNode(). Returns the raw
 * FSWatcher — call `.close()` to stop, same as createWatcher() itself.
 *
 * Content is read here (not by the watcher, which only supplies the path)
 * because writeFileStateNode() needs the actual bytes to hash and store.
 * A read failure (e.g. the file was deleted or renamed between the fs event
 * firing and this read — some editors save via write-then-rename) is
 * swallowed rather than thrown: one race on one file must not take down the
 * whole capture pipeline. Not a named SSOT requirement, a standard
 * defensive measure.
 *
 * When `queue` is supplied (Phase 7.2), a queue write failure is swallowed
 * the same way a read failure is — one bad event must not take down the
 * capture pipeline or surface as an unhandled rejection.
 */
export function createFileStateCapture(
  db: Database.Database,
  fsm: SessionFsm,
  projectRoot: string,
  queue?: IngestionQueue,
): FSWatcher {
  return createWatcher(projectRoot, {
    onChange: (filePath) => {
      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        return;
      }
      if (queue) {
        queue
          .enqueueOverflowable({ filePath, content }, (item) =>
            writeFileStateNode(db, fsm, item.filePath, item.content)
          )
          .catch(() => {});
      } else {
        writeFileStateNode(db, fsm, filePath, content);
      }
    },
  });
}
