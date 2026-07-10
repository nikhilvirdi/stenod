import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { openDatabase, runMigrations } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { IngestionQueue } from '../capture/queue.js';
import { createFileStateCapture } from '../capture/file-state.js';
import { attachWorkspace, pidLockPath } from '../workspace/sandbox.js';
import { startDaemon, stopDaemon } from './lifecycle.js';
import type { DaemonHandle } from './lifecycle.js';

/**
 * Phase 7.2 — `stenod start` / `stenod stop` Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] `start` brings up a daemon that actually captures fs events
 *   [x] `stop` cleanly shuts it down, no orphaned processes
 *
 * REGRESSION FIX re-flag: `startDaemon()` previously also unconditionally
 * spawned a terminal capture (`createTerminalCapture`) that fell back to a
 * real default shell nothing could ever feed commands to — killing it on
 * `stop()` wrote a synthetic `TERMINAL_SUCCESS` node into every real
 * session (Gap 4, `cli/e2e.test.ts`). `startDaemon()` no longer spawns
 * terminal capture at all (fs-only until a future phase builds the real
 * mechanism for routing developer terminal input to a backgrounded
 * daemon — Gap 3), so `DaemonHandle` no longer has a `terminal` field and
 * this test file's coverage below is fs-only. SSOT §5's "filesystem +
 * terminal" framing for the default tier is therefore currently
 * aspirational for a *running* daemon — flagged here per the project's
 * regression rule, not silently resolved. This phase's literal *Verify*
 * line ("start, trigger a file save, confirm a DB row, stop, confirm
 * process exit") was always fs-only and still holds as written.
 *
 * Coverage:
 *   1. The Phase 7.2 addition to createFileStateCapture() (an optional
 *      `queue` param) actually routes a real save through a real
 *      IngestionQueue into the DB.
 *   2. stopDaemon() waits for the queue to actually drain (debounced, not a
 *      premature "read 0 once" false positive) before resolving.
 *   3. stopDaemon() throws — rather than silently proceeding — if the
 *      queue never drains within the timeout.
 *   4. stopDaemon() releases the Phase 2.1 PID lock and closes the DB.
 *   5. Full integration test matching the phase's literal Verify line:
 *      start, trigger a file save, confirm a DB row, stop, confirm clean
 *      shutdown.
 */
describe('daemon/lifecycle — Phase 7.2', () => {
  const tempDirs: string[] = [];
  let db: Database.Database | undefined;

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-lifecycle-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // Already closed by the test itself — fine.
      }
      db = undefined;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (predicate()) {
          clearInterval(interval);
          resolve(true);
        } else if (Date.now() - start >= timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      }, 25);
    });
  }

  // ── Cross-platform: fs-track queue wiring ────────────────────────────────

  it('a real file save through createFileStateCapture(..., queue) is routed through the queue into the DB', async () => {
    const root = makeTempRoot();
    db = openDatabase(join(root, 'graph.db'));
    runMigrations(db);
    const fsm = new SessionFsm();
    const queue = new IngestionQueue();

    let watcher: FSWatcher | undefined;
    try {
      watcher = createFileStateCapture(db, fsm, root, queue);
      await new Promise<void>((resolve) => watcher!.once('ready', resolve));

      const srcFile = join(root, 'src', 'index.ts');
      mkdirSync(join(srcFile, '..'), { recursive: true });
      writeFileSync(srcFile, 'export const x = 1;', 'utf8');

      const found = await waitFor(() => {
        const row = db!.prepare("SELECT * FROM graph_nodes WHERE type = 'FILE_STATE'").get();
        return row !== undefined;
      }, 3000);

      expect(found, 'expected a FILE_STATE row written via the queue').toBe(true);
      expect(queue.depth).toBe(0);
    } finally {
      await watcher?.close();
    }
  });

  // ── Cross-platform: stopDaemon's drain-wait logic ────────────────────────

  function fakeHandle(overrides: Partial<DaemonHandle> = {}): DaemonHandle {
    const root = makeTempRoot();
    // A real Phase 2.1 lock so detachWorkspace()/existsSync assertions are meaningful.
    const resolvedRoot = attachWorkspace(root);
    db = openDatabase(join(root, '.stenod', 'graph.db'));
    runMigrations(db);

    const stubWatcher = { close: async () => {} } as unknown as FSWatcher;

    return {
      projectRoot: resolvedRoot,
      stenoDir: join(resolvedRoot, '.stenod'),
      db: db!,
      fsm: new SessionFsm(),
      queue: new IngestionQueue(),
      watcher: stubWatcher,
      ...overrides,
    };
  }

  it('stopDaemon waits for a slow-draining queue to actually settle before resolving', async () => {
    const handle = fakeHandle();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    void handle.queue.enqueue(async () => {
      await gate;
      order.push('task-settled');
    });

    setTimeout(() => {
      order.push('gate-released');
      release();
    }, 60);

    await stopDaemon(handle, { timeoutMs: 2000, quietPeriodMs: 30, pollIntervalMs: 5 });
    order.push('stop-resolved');

    expect(order).toEqual(['gate-released', 'task-settled', 'stop-resolved']);
    expect(existsSync(pidLockPath(handle.projectRoot))).toBe(false);
  });

  it('stopDaemon throws if the queue never drains within the timeout', async () => {
    const handle = fakeHandle();
    // A task that never settles — simulates a stuck write.
    void handle.queue.enqueue(() => new Promise<void>(() => {}));

    await expect(
      stopDaemon(handle, { timeoutMs: 100, quietPeriodMs: 20, pollIntervalMs: 5 })
    ).rejects.toThrow(/timed out waiting for the ingestion queue to drain/);
  });

  // ── Cross-platform: clean shutdown bookkeeping ───────────────────────────

  it('stopDaemon releases the PID lock and closes the DB on a successful drain', async () => {
    const handle = fakeHandle();

    expect(existsSync(pidLockPath(handle.projectRoot))).toBe(true);

    await stopDaemon(handle, { timeoutMs: 1000, quietPeriodMs: 20, pollIntervalMs: 5 });

    expect(existsSync(pidLockPath(handle.projectRoot))).toBe(false);
    expect(() => handle.db.prepare('SELECT 1').get()).toThrow();
    db = undefined; // already closed by stopDaemon; afterEach shouldn't double-close.
  });

  // ── Full start -> save -> stop integration (fs-only; matches the phase's
  // literal Verify line, which was always fs-only) ────────────────────────

  it('start brings up a daemon that captures fs events, and stop cleanly shuts it down (Phase 7.2 Verify line)', async () => {
    const root = makeTempRoot();
    const handle: DaemonHandle = startDaemon(root);
    db = handle.db;

    await new Promise<void>((resolve) => handle.watcher.once('ready', resolve));

    const srcFile = join(root, 'src', 'index.ts');
    mkdirSync(join(srcFile, '..'), { recursive: true });
    writeFileSync(srcFile, 'export const x = 1;', 'utf8');

    const fsRowFound = await waitFor(() => {
      const row = handle.db.prepare("SELECT * FROM graph_nodes WHERE type = 'FILE_STATE'").get();
      return row !== undefined;
    }, 3000);
    expect(fsRowFound, 'expected a FILE_STATE row').toBe(true);

    const rowCount = (
      handle.db.prepare('SELECT COUNT(*) AS cnt FROM graph_nodes').get() as { cnt: number }
    ).cnt;
    expect(rowCount).toBe(1);

    const resolvedRoot = handle.projectRoot;
    await stopDaemon(handle);
    db = undefined; // stopDaemon() closed it.

    expect(existsSync(pidLockPath(resolvedRoot))).toBe(false);
  });
});
