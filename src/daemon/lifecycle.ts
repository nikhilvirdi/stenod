import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { attachWorkspace, detachWorkspace, stenoDir } from '../workspace/sandbox.js';
import { createIpcServer } from '../workspace/ipc.js';
import type { IpcServer } from '../workspace/ipc.js';
import { openDatabase, runMigrations } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { IngestionQueue } from '../capture/queue.js';
import { createFileStateCapture } from '../capture/file-state.js';
import { createTerminalBridgeHandler } from './terminal-bridge.js';

/**
 * Phase 7.2 — `stenod start` / `stenod stop`
 *
 * SSOT §5: "stenod start | Start the ingestion daemon (default tier:
 * filesystem + terminal)." / "stenod stop | Stop the daemon."
 *
 * Build line: "daemon process start/stop logic, wiring together the
 * capture tracks (4.x, 5.x) and the ingestion queue (6.x) into one running
 * process." This is the wiring Phase 6.1's own header comment explicitly
 * deferred here: `createFileStateCapture` now accepts an optional `queue`
 * parameter (see file-state.ts's Phase 7.2 addition notes) which
 * `startDaemon()` supplies, so the fs track writes through the shared
 * `IngestionQueue` instead of directly to SQLite.
 *
 * Scope note (Do NOT, by the same precedent Phase 7.1 states explicitly):
 * this builds the underlying start/stop functions only — no `commander`
 * CLI command is wired up (that's Milestone 10, not yet started).
 *
 * REGRESSION FIX (post-Phase-10.7, both this phase and 10.7 re-flagged for
 * re-verification): `startDaemon()` previously also unconditionally called
 * `createTerminalCapture(db, fsm, options.terminal ?? {}, queue)`. With no
 * terminal options supplied — which is how the real CLI (`program.ts`)
 * always invokes it — that spawned a real default shell
 * (`process.env.SHELL || '/bin/sh'`, terminal.ts) that nothing could ever
 * feed real commands to: there is no IPC bridge from a user's actual
 * terminal input to a backgrounded daemon's own PTY (documented as Gap 3
 * in `cli/e2e.test.ts`). `stopDaemon()` killing that idle shell reported a
 * clean exit, so `writeTerminalNode()` wrote a synthetic `TERMINAL_SUCCESS`
 * node (raw shell-prompt escape-code noise) into every real Unix/Mac
 * session — and, since nothing in the compiler filters by node type, that
 * junk node was packed into every real handoff manifest (Gap 4, confirmed
 * against real Linux CI diagnostic data). The fix is to not spawn it: the
 * daemon captures filesystem events only until a future phase builds the
 * real mechanism (Gap 3) to route developer terminal input to a
 * backgrounded daemon's capture track. SSOT §5's "filesystem + terminal"
 * framing and this phase's "Done when" checklist item ("captures
 * fs+terminal events") are therefore currently aspirational, not met by
 * the running daemon — flagged here rather than silently resolved; the
 * phase's literal *Verify* line (start, file save, DB row, stop, process
 * exit) is fs-only and still holds.
 *
 * Design decisions (documented for review):
 * -----------------------------------------------------------------------
 * - `attachWorkspace()` is called here (not released afterward, unlike
 *   Phase 7.1's `stenodInit()`) because `startDaemon()` IS the persistent
 *   daemon process the PID lock is meant to represent — the lock is held
 *   for the daemon's whole running lifetime and released by `stopDaemon()`.
 * - The queue's `maxDepth`/`overflowDir` (Phase 6.2) are always configured
 *   (not left unlimited) — SSOT §6.1 describes "shared max in-flight
 *   depth" as an intrinsic property of the ingestion queue, not an opt-in.
 *   No specific number is given anywhere in SSOT/WORKPLAN, so
 *   `DEFAULT_MAX_QUEUE_DEPTH` below is a documented, overridable
 *   engineering default — a tuning knob, not a correctness-affecting
 *   choice (`enqueueOverflowable()` never drops events regardless of
 *   depth; it only decides resident-vs-disk-backed).
 * - `stopDaemon()` needs to know that all in-flight writes have actually
 *   settled before closing the DB, otherwise a write-after-close race is
 *   possible and "clean shutdown" wouldn't be true. This reuses
 *   `IngestionQueue.depth` — a value Phase 6.1/6.2 already expose
 *   specifically for this kind of accounting — via a bounded, debounced
 *   poll (`waitForQueueDrain`): drained is only declared once `depth` has
 *   read 0 continuously for a quiet period, so a momentary "0 because a
 *   write hasn't been enqueued yet" reading can't be mistaken for "fully
 *   drained." This mirrors the polling pattern this codebase already uses
 *   for async completion detection (e.g. `waitFor()` in
 *   terminal-state.test.ts).
 *
 * Phase 7.5 addition — closes Gap 3 (above): `startDaemon()` now also
 * starts a Phase 2.3 `IpcServer`, wired to `terminal-bridge.ts`'s
 * `createTerminalBridgeHandler()` via `createIpcServer()`'s new (Phase 7.5)
 * `onMessage` hook. This does NOT spawn a PTY in the daemon — that was
 * exactly Gap 4's root cause (an unreachable, unfed shell). Instead, a
 * separate client (`stenod attach`, `cli/attach.ts`) owns the actual PTY in
 * the user's real terminal (which has a real TTY; this daemon does not) and
 * reports the accumulated content + exit code over the now-authenticated
 * connection once that shell exits. `startDaemon()` is now `async` because
 * `IpcServer.listen()` is — every existing caller needs an `await` added,
 * which is the one behavioral change to already-Verified Phase 7.2 callers;
 * filesystem-capture behavior itself is unchanged. `stopDaemon()` closes the
 * IPC server alongside the fs watcher, so a stopped daemon accepts no new
 * connections and `stenod attach` sessions fail cleanly rather than hanging.
 *
 * Known, explicitly-accepted limitation (per user confirmation): Phase 5.4's
 * live stderr-heuristic crash detection (for long-running processes that
 * never exit within a session) does not fire for `stenod attach` sessions —
 * the daemon only receives the final accumulated result once the client's
 * shell exits, not live batches as they arrive. Only exit-code-driven
 * `TERMINAL_SUCCESS`/`TERMINAL_ERROR` is guaranteed for bridged sessions.
 * Also documented in `WORKPLAN.md`'s Phase 7.5 entry and slated for
 * `SECURITY.md`'s next revision.
 */

const DEFAULT_MAX_QUEUE_DEPTH = 500;
const DRAIN_TIMEOUT_MS = 5000;
const DRAIN_QUIET_PERIOD_MS = 150;
const DRAIN_POLL_INTERVAL_MS = 10;

export interface StartDaemonOptions {
  /** Overrides the ingestion queue's shared max in-flight depth (Phase 6.2). Defaults to 500. */
  maxQueueDepth?: number;
}

export interface StopDaemonOptions {
  /** Max time to wait for the queue to fully drain before throwing. Defaults to 5000ms. */
  timeoutMs?: number;
  /** How long queue.depth must read 0 continuously before drain is declared complete. Defaults to 150ms. */
  quietPeriodMs?: number;
  /** Poll interval while waiting for drain. Defaults to 10ms. */
  pollIntervalMs?: number;
}

export interface DaemonHandle {
  projectRoot: string;
  stenoDir: string;
  db: Database.Database;
  fsm: SessionFsm;
  queue: IngestionQueue;
  watcher: FSWatcher;
  /** Phase 7.5 — the token-enforced bridge for `stenod attach` terminal sessions. */
  ipcServer: IpcServer;
}

/**
 * Starts the ingestion daemon for `projectRoot`: acquires the Phase 2.1
 * workspace lock, opens/migrates the SQLite DB, brings up the filesystem
 * (4.4) capture track wired through the shared IngestionQueue (6.1/6.2),
 * and (Phase 7.5) starts the Phase 2.3 IPC server, wired to the terminal
 * bridge (`terminal-bridge.ts`).
 *
 * Terminal capture is NOT spawned directly by the daemon — see the "Phase
 * 7.5 addition" note in this file's header comment for why (Gap 3/Gap 4).
 * A separate client (`stenod attach`) owns the actual PTY and reports
 * results over the IPC connection this function now also starts.
 *
 * Throws `WorkspaceLockedError` (Phase 2.1) if a live daemon already owns
 * this root.
 */
export async function startDaemon(
  projectRoot: string,
  options: StartDaemonOptions = {}
): Promise<DaemonHandle> {
  const resolvedRoot = attachWorkspace(projectRoot);
  const dir = stenoDir(resolvedRoot);

  const db = openDatabase(join(dir, 'graph.db'));
  runMigrations(db);

  const fsm = new SessionFsm();

  const queue = new IngestionQueue({
    maxDepth: options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
    overflowDir: join(dir, 'queue-overflow'),
  });

  const watcher = createFileStateCapture(db, fsm, resolvedRoot, queue);

  const ipcServer = createIpcServer(resolvedRoot, {
    onMessage: createTerminalBridgeHandler(db, fsm, queue),
  });
  await ipcServer.listen();

  return { projectRoot: resolvedRoot, stenoDir: dir, db, fsm, queue, watcher, ipcServer };
}

/**
 * Polls `queue.depth` until it reads 0 continuously for `quietPeriodMs`
 * (debounced, so a momentary zero before a not-yet-enqueued write doesn't
 * count), or returns false after `timeoutMs`.
 */
async function waitForQueueDrain(
  queue: IngestionQueue,
  {
    timeoutMs = DRAIN_TIMEOUT_MS,
    quietPeriodMs = DRAIN_QUIET_PERIOD_MS,
    pollIntervalMs = DRAIN_POLL_INTERVAL_MS,
  }: { timeoutMs?: number; quietPeriodMs?: number; pollIntervalMs?: number } = {}
): Promise<boolean> {
  const start = Date.now();
  let zeroSince: number | undefined;

  while (Date.now() - start < timeoutMs) {
    if (queue.depth === 0) {
      zeroSince ??= Date.now();
      if (Date.now() - zeroSince >= quietPeriodMs) {
        return true;
      }
    } else {
      zeroSince = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return queue.depth === 0;
}

/**
 * Cleanly stops a daemon started via `startDaemon()`:
 *   1. Stops the filesystem watcher and the IPC server (Phase 7.5) — no new
 *      fs events or `stenod attach` connections after this.
 *   2. Waits for every in-flight/queued write to settle.
 *   3. Closes the DB connection and releases the Phase 2.1 workspace lock.
 *
 * (No terminal process to kill — the daemon itself never spawns one; see
 * this file's header comment. Any still-attached `stenod attach` client's
 * shell keeps running in the client's own process; its eventual
 * terminal-result report will simply fail to reach a stopped daemon, and
 * the client surfaces that as a clear error rather than hanging silently.)
 *
 * Throws if the queue does not fully drain within the timeout — proceeding
 * to close the DB with writes still in flight would silently lose events,
 * which contradicts "cleanly shuts down." `options` overrides the drain
 * wait's timing (defaults documented on `waitForQueueDrain`); primarily
 * useful for tests that want to exercise the timeout path without a real
 * multi-second wait.
 */
export async function stopDaemon(
  handle: DaemonHandle,
  options: StopDaemonOptions = {}
): Promise<void> {
  await handle.watcher.close();
  await handle.ipcServer.close();

  const drained = await waitForQueueDrain(handle.queue, options);
  if (!drained) {
    throw new Error(
      `stenod: daemon stop timed out waiting for the ingestion queue to drain ` +
        `(depth=${handle.queue.depth}) — some events may not have been written before shutdown.`
    );
  }

  handle.db.close();
  detachWorkspace(handle.projectRoot);
}
