/**
 * Phase 5.3 — Exit-Code Signal → Node Creation
 *
 * SSOT §6.1: "Success/failure signal is the shell exit code for commands
 * that terminate — language-agnostic, doesn't depend on matching
 * test-runner-specific output strings."
 * SSOT §6.3: the FSM's ERROR event is driven by "stderr/nonzero exit" —
 * there is no FSM event for a successful exit (FSM_EVENTS is exactly
 * ERROR, SAVE, COMMIT per Phase 3.1), so a zero exit code produces a
 * TERMINAL_SUCCESS node but does not advance the FSM.
 *
 * Mirrors the shape of Phase 4.4's file-state.ts: a pure node-writing
 * function plus a wiring factory, following the same conventions
 * (SHA-256 content id, MAX(event_id)+1, INSERT OR IGNORE on id collision).
 *
 * Scope note: does not apply secret redaction to terminal content — per
 * the precedent set by Phase 4.4/4.5, that is Phase 5.5's job
 * ("apply the same redaction pass from Phase 4.5 to terminal content
 * before storage"), which explicitly depends on this phase.
 *
 * Phase 5.4 addition: createTerminalCapture() also scans each freshly
 * batched chunk (not the whole accumulated buffer — a chunk is only ever
 * scanned once, as it arrives) for SSOT §6.1's crash-shaped stderr
 * patterns, independent of whether/when the process eventually exits. See
 * terminal-heuristic.ts for why this doesn't drive the FSM.
 *
 * Phase 5.5 addition: writeTerminalNode() now redacts content via the same
 * redactSecrets() pass Phase 4.5 applies to filesystem content, before it
 * is hashed or stored — so `id` (SHA-256 "of content") matches what's
 * actually persisted, same reasoning as file-state.ts.
 *
 * Phase 7.2 addition: createTerminalCapture() now accepts an optional
 * `queue` (Phase 6.1/6.2's IngestionQueue) as a 4th parameter, mirroring
 * file-state.ts's Phase 7.2 addition. When provided, both write call sites
 * (the exit-triggered writeTerminalNode() and the heuristic
 * writeHeuristicCrashNode()) route through `queue.enqueueOverflowable()`
 * instead of writing inline. `queue` is optional and purely additive —
 * every existing call site that omits it keeps the exact original
 * inline-write behavior and return type, so this is non-breaking for Phase
 * 5.3/5.4/5.5's already-Verified callers/tests.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { TerminalWrapper } from './terminal.js';
import type { TerminalWrapperOptions } from './terminal.js';
import { TerminalBatcher } from './batcher.js';
import { looksLikeCrash, writeHeuristicCrashNode } from './terminal-heuristic.js';
import { nextEventId } from '../storage/index.js';
import { redactSecrets } from './redaction.js';
import type { IngestionQueue } from './queue.js';
import type { SessionFsm, FsmState } from '../lifecycle/index.js';

export type TerminalNodeType = 'TERMINAL_SUCCESS' | 'TERMINAL_ERROR';

export interface TerminalWriteResult {
  /** SHA-256 hex digest of `content` (SSOT §6.2: graph_nodes.id). */
  id: string;
  eventId: number;
  type: TerminalNodeType;
  fsmState: FsmState;
  /** False when a node with this exact content hash already existed. */
  created: boolean;
}



/**
 * Writes one graph_nodes row for a terminated command: `TERMINAL_SUCCESS`
 * for exit code 0, `TERMINAL_ERROR` otherwise.
 *
 * FSM association: a non-zero exit fires the FSM's ERROR event (SSOT §6.3),
 * and the resulting state is stored as the node's fsm_state. A zero exit
 * does not drive any FSM event — there is no "success" event in the FSM
 * (Phase 3.1's FSM_EVENTS is exactly ERROR/SAVE/COMMIT) — so the node's
 * fsm_state is simply a snapshot of the FSM's current (unchanged) state.
 *
 * id-collision handling matches writeFileStateNode(): `INSERT OR IGNORE`,
 * so byte-identical output from two different command runs (e.g. two
 * successive no-op `true` calls) doesn't throw or overwrite an existing
 * row's status. The FSM still advances on every non-zero-exit call
 * regardless of whether a new row was written.
 */
export function writeTerminalNode(
  db: Database.Database,
  fsm: SessionFsm,
  content: string,
  exitCode: number,
): TerminalWriteResult {
  const type: TerminalNodeType = exitCode === 0 ? 'TERMINAL_SUCCESS' : 'TERMINAL_ERROR';
  const fsmState: FsmState = exitCode === 0 ? fsm.state : fsm.apply('ERROR').to;

  const redacted = redactSecrets(content);
  const id = createHash('sha256').update(redacted).digest('hex');
  const eventId = nextEventId(db);

  const info = db
    .prepare(
      `INSERT OR IGNORE INTO graph_nodes
         (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'ACTIVE', NULL, ?)`,
    )
    .run(id, eventId, type, redacted, fsmState, Date.now());

  return { id, eventId, type, fsmState, created: info.changes > 0 };
}

export interface CaptureWrapper extends TerminalWrapper {
  /** Resolves when the underlying process has exited and all DB writes have settled. */
  captureClosed: Promise<void>;
}

export interface TerminalCaptureOptions extends Omit<TerminalWrapperOptions, 'onData' | 'onExit'> {
  batchIntervalMs?: number;
  highWaterMarkBytes?: number;
}

/**
 * Spawns a Phase 5.1 TerminalWrapper (through the Phase 5.2 TerminalBatcher
 * for 16ms batching / 64KB backpressure), accumulates its batched output
 * for the lifetime of the command, and on exit flushes any remaining
 * buffered output and writes one terminal node via writeTerminalNode().
 *
 * Returns the underlying TerminalWrapper so callers can write stdin, resize,
 * or kill the process, same as constructing one directly.
 */
export function createTerminalCapture(
  db: Database.Database,
  fsm: SessionFsm,
  options: TerminalCaptureOptions,
  queue?: IngestionQueue,
): CaptureWrapper {
  let accumulated = '';
  // Phase 5.4: fires at most once per capture session — the first
  // crash-shaped chunk is the signal; later chunks (which may well repeat
  // the same stack trace as a log scrolls) don't create duplicate nodes.
  let heuristicFlagged = false;
  // Forward-referenced: TerminalBatcher's constructor needs `terminal` (the
  // wrapper) for pause()/resume(), but the wrapper's onData callback needs
  // to feed the batcher. Both callbacks only fire asynchronously (after PTY
  // I/O), by which point `batcher` below is already assigned. Must be `let`
  // (assigned after declaration) even though it's only ever assigned once.
  // eslint-disable-next-line prefer-const
  let batcher: TerminalBatcher;

  let resolveClosed!: () => void;
  const captureClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const pendingWrites: Promise<void>[] = [];

  const wrapper = new TerminalWrapper({
    ...options,
    onData: (chunk) => batcher.onData(chunk),
    onExit: (exitCode) => {
      void (async () => {
        try {
          await batcher.flush();
          batcher.cleanup();
          if (queue) {
            pendingWrites.push(
              queue
                .enqueueOverflowable({ content: accumulated, exitCode }, (item) =>
                  writeTerminalNode(db, fsm, item.content, item.exitCode)
                )
                .catch(() => {})
            );
          } else {
            writeTerminalNode(db, fsm, accumulated, exitCode);
          }
          await Promise.all(pendingWrites);
        } finally {
          resolveClosed();
        }
      })();
    },
  });

  batcher = new TerminalBatcher({
    terminal: wrapper,
    onBatch: (data) => {
      accumulated += data;
      // Scan only the newly-arrived chunk, not the whole accumulated
      // buffer — a line already scanned in a prior batch isn't re-matched.
      if (!heuristicFlagged && looksLikeCrash(data)) {
        heuristicFlagged = true;
        if (queue) {
          pendingWrites.push(
            queue
              .enqueueOverflowable({ content: accumulated }, (item) =>
                writeHeuristicCrashNode(db, fsm, item.content)
              )
              .catch(() => {})
          );
        } else {
          writeHeuristicCrashNode(db, fsm, accumulated);
        }
      }
    },
    batchIntervalMs: options.batchIntervalMs,
    highWaterMarkBytes: options.highWaterMarkBytes,
  });

  const captureWrapper = wrapper as CaptureWrapper;
  captureWrapper.captureClosed = captureClosed;
  return captureWrapper;
}
