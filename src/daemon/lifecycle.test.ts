import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
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
import type { TerminalWrapper } from '../capture/terminal.js';

/**
 * Phase 7.2 — `stenod start` / `stenod stop` Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] `start` brings up a daemon that actually captures fs+terminal events
 *   [x] `stop` cleanly shuts it down, no orphaned processes
 *
 * Coverage, split by what genuinely needs a real PTY (Unix/Mac only per
 * SSOT §6.1, same platform gate already used throughout capture/terminal*
 * tests) versus what doesn't:
 *
 * Cross-platform:
 *   1. The Phase 7.2 addition to createFileStateCapture() (an optional
 *      `queue` param) actually routes a real save through a real
 *      IngestionQueue into the DB — the fs half of "captures fs+terminal
 *      events," independent of node-pty.
 *   2. stopDaemon() waits for the queue to actually drain (debounced, not a
 *      premature "read 0 once" false positive) before resolving.
 *   3. stopDaemon() throws — rather than silently proceeding — if the
 *      queue never drains within the timeout.
 *   4. stopDaemon() releases the Phase 2.1 PID lock and closes the DB.
 *
 * Unix/Mac only (gated, matching capture/terminal*.test.ts precedent):
 *   5. Full integration test matching the phase's literal Verify line:
 *      start, trigger a file save, confirm a DB row, run a real terminal
 *      command, confirm its row, stop, confirm clean shutdown.
 */
describe('daemon/lifecycle — Phase 7.2', () => {
  const isWindows = os.platform() === 'win32';
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
    const stubTerminal = { kill: () => {} } as unknown as TerminalWrapper;

    return {
      projectRoot: resolvedRoot,
      stenoDir: join(resolvedRoot, '.stenod'),
      db: db!,
      fsm: new SessionFsm(),
      queue: new IngestionQueue(),
      watcher: stubWatcher,
      terminal: stubTerminal,
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

  // ── Unix/Mac only: full start -> save -> terminal -> stop integration ───

  it('start brings up a daemon that captures fs+terminal events, and stop cleanly shuts it down (Phase 7.2 Verify line)', async () => {
    if (isWindows) return;

    const root = makeTempRoot();
    let handle: DaemonHandle | undefined;
    try {
      handle = startDaemon(root, { terminal: { shell: 'sh', args: ['-c', 'echo "all good"'] } });
      db = handle.db;

      await new Promise<void>((resolve) => handle!.watcher.once('ready', resolve));

      const srcFile = join(root, 'src', 'index.ts');
      mkdirSync(join(srcFile, '..'), { recursive: true });
      writeFileSync(srcFile, 'export const x = 1;', 'utf8');

      const fsRowFound = await waitFor(() => {
        const row = handle!.db.prepare("SELECT * FROM graph_nodes WHERE type = 'FILE_STATE'").get();
        return row !== undefined;
      }, 3000);
      expect(fsRowFound, 'expected a FILE_STATE row').toBe(true);

      const terminalRowFound = await waitFor(() => {
        const row = handle!.db
          .prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_SUCCESS'")
          .get();
        return row !== undefined;
      }, 3000);
      expect(terminalRowFound, 'expected a TERMINAL_SUCCESS row').toBe(true);

      const rowCount = (
        handle.db.prepare('SELECT COUNT(*) AS cnt FROM graph_nodes').get() as { cnt: number }
      ).cnt;
      expect(rowCount).toBe(2);

      const resolvedRoot = handle.projectRoot;
      await stopDaemon(handle);
      db = undefined; // stopDaemon() closed it.

      expect(existsSync(pidLockPath(resolvedRoot))).toBe(false);
    } finally {
      // Best-effort cleanup if an assertion threw before stopDaemon() ran.
      if (handle && db) {
        try {
          handle.terminal.kill();
        } catch {
          /* already exited */
        }
      }
    }
  });
});
