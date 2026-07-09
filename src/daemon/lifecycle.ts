import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { attachWorkspace, detachWorkspace, stenoDir } from '../workspace/sandbox.js';
import { openDatabase, runMigrations } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { IngestionQueue } from '../capture/queue.js';
import { createFileStateCapture } from '../capture/file-state.js';
import { createTerminalCapture } from '../capture/terminal-state.js';
import type { TerminalCaptureOptions, CaptureWrapper } from '../capture/terminal-state.js';

/**
 * Phase 7.2 — `stenod start` / `stenod stop`
 *
 * SSOT §5: "stenod start | Start the ingestion daemon (default tier:
 * filesystem + terminal)." / "stenod stop | Stop the daemon."
 *
 * Build line: "daemon process start/stop logic, wiring together the
 * capture tracks (4.x, 5.x) and the ingestion queue (6.x) into one running
 * process." This is the wiring Phase 6.1's own header comment explicitly
 * deferred here: `createFileStateCapture`/`createTerminalCapture` now
 * accept an optional `queue` parameter (see file-state.ts/terminal-state.ts
 * Phase 7.2 addition notes) which `startDaemon()` supplies, so both tracks
 * write through one shared `IngestionQueue` instead of directly to SQLite.
 *
 * Scope note (Do NOT, by the same precedent Phase 7.1 states explicitly):
 * this builds the underlying start/stop functions only — no `commander`
 * CLI command is wired up (that's Milestone 10, not yet started).
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
 * - `stopDaemon()` needs to know that all in-flight writes — including the
 *   terminal's exit-triggered write, which only gets enqueued
 *   asynchronously after `terminal.kill()` is called — have actually
 *   settled before closing the DB, otherwise a write-after-close race is
 *   possible and "clean shutdown" wouldn't be true. Rather than changing
 *   `createTerminalCapture()`'s return type to expose a completion signal
 *   (which would force Phase 5.3's already-Verified test file to change
 *   too), this reuses `IngestionQueue.depth` — a value Phase 6.1/6.2
 *   already expose specifically for this kind of accounting — via a
 *   bounded, debounced poll (`waitForQueueDrain`): drained is only
 *   declared once `depth` has read 0 continuously for a quiet period, so a
 *   momentary "0 because the exit write hasn't been enqueued yet" reading
 *   can't be mistaken for "fully drained." This mirrors the polling
 *   pattern this codebase already uses for async completion detection
 *   (e.g. `waitFor()` in terminal-state.test.ts).
 */

const DEFAULT_MAX_QUEUE_DEPTH = 500;
const DRAIN_TIMEOUT_MS = 5000;
const DRAIN_QUIET_PERIOD_MS = 150;
const DRAIN_POLL_INTERVAL_MS = 10;

export interface StartDaemonOptions {
  /** Overrides the ingestion queue's shared max in-flight depth (Phase 6.2). Defaults to 500. */
  maxQueueDepth?: number;
  /** Forwarded to createTerminalCapture()/TerminalWrapper (shell, args, cwd, env, batching, etc.). */
  terminal?: TerminalCaptureOptions;
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
  terminal: CaptureWrapper;
}

/**
 * Starts the ingestion daemon for `projectRoot`: acquires the Phase 2.1
 * workspace lock, opens/migrates the SQLite DB, and brings up both the
 * filesystem (4.4) and terminal (5.3) capture tracks wired through one
 * shared IngestionQueue (6.1/6.2).
 *
 * Throws `WorkspaceLockedError` (Phase 2.1) if a live daemon already owns
 * this root.
 */
export function startDaemon(projectRoot: string, options: StartDaemonOptions = {}): DaemonHandle {
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
  const terminal = createTerminalCapture(db, fsm, options.terminal ?? {}, queue);

  return { projectRoot: resolvedRoot, stenoDir: dir, db, fsm, queue, watcher, terminal };
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
 *   1. Stops the filesystem watcher (no new fs events after this).
 *   2. Kills the wrapped terminal process (safe if it already exited).
 *   3. Waits for every in-flight/queued write — including the terminal's
 *      exit-triggered write — to settle.
 *   4. Closes the DB connection and releases the Phase 2.1 workspace lock.
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

  try {
    handle.terminal.kill();
    await handle.terminal.captureClosed;
  } catch {
    // Already exited — nothing to do.
  }

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
