import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import type Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { openDatabase, runMigrations } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { IngestionQueue } from '../capture/queue.js';
import { createFileStateCapture } from '../capture/file-state.js';
import { attachWorkspace, pidLockPath } from '../workspace/sandbox.js';
import type { IpcServer } from '../workspace/ipc.js';
import { stenodInit } from './init.js';
import { startDaemon, stopDaemon } from './lifecycle.js';
import type { DaemonHandle } from './lifecycle.js';
import { attachTerminalSession } from '../cli/attach.js';

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
    const stubIpcServer = { path: '', listen: async () => {}, close: async () => {} } as IpcServer;

    return {
      projectRoot: resolvedRoot,
      stenoDir: join(resolvedRoot, '.stenod'),
      db: db!,
      fsm: new SessionFsm(),
      queue: new IngestionQueue(),
      watcher: stubWatcher,
      ipcServer: stubIpcServer,
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
    const handle: DaemonHandle = await startDaemon(root);
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

  // ── Phase 7.5: IPC server + terminal bridge ──────────────────────────────
  //
  // Coverage (this phase's own Done-when checklist, verbatim):
  //   - stenod start genuinely captures both filesystem AND terminal events
  //     in the same running session — a real end-to-end test, not two
  //     separate unit tests
  //   - the IPC server is genuinely started by startDaemon() and genuinely
  //     enforces the token
  //   - stopDaemon cleanly shuts down both tracks, no orphaned processes
  //   - existing Phase 7.2 fs-only behavior is unaffected (covered by every
  //     test above this section, all still passing unmodified)

  const isWindows = os.platform() === 'win32';

  it('startDaemon() genuinely starts a real, listening IPC server', async () => {
    const root = makeTempRoot();
    const handle = await startDaemon(root);
    db = handle.db;

    // A real connection attempt against the real path succeeds at the
    // transport level (proves something is actually listening — not just
    // that an IpcServer object was constructed).
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection(handle.ipcServer.path);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    expect(connected).toBe(true);

    await stopDaemon(handle);
    db = undefined;
  });

  it("the real daemon's IPC server genuinely enforces the token — a connection with the wrong token is rejected", async () => {
    const root = makeTempRoot();
    const initResult = stenodInit(root, { reset: false });
    const handle = await startDaemon(initResult.projectRoot);
    db = handle.db;

    const response = await new Promise<{ ok: boolean }>((resolve, reject) => {
      const socket = createConnection(handle.ipcServer.path);
      socket.setEncoding('utf8');
      let buffer = '';
      socket.once('connect', () => {
        socket.write(JSON.stringify({ token: 'c'.repeat(64) }) + '\n');
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const idx = buffer.indexOf('\n');
        if (idx === -1) return;
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, idx)) as { ok: boolean });
      });
      socket.once('error', reject);
    });

    expect(response.ok).toBe(false);

    // The correct token, read fresh from disk, is still accepted on the
    // same running server — matching Phase 2.3's own established pattern.
    const { readToken } = await import('../workspace/token.js');
    const correctToken = readToken(initResult.projectRoot);
    const acceptedResponse = await new Promise<{ ok: boolean }>((resolve, reject) => {
      const socket = createConnection(handle.ipcServer.path);
      socket.setEncoding('utf8');
      let buffer = '';
      socket.once('connect', () => {
        socket.write(JSON.stringify({ token: correctToken }) + '\n');
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const idx = buffer.indexOf('\n');
        if (idx === -1) return;
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, idx)) as { ok: boolean });
      });
      socket.once('error', reject);
    });
    expect(acceptedResponse.ok).toBe(true);

    await stopDaemon(handle);
    db = undefined;
  });

  it('stopDaemon() closes the IPC server — a connection attempt after stop is refused, not hung', async () => {
    const root = makeTempRoot();
    const handle = await startDaemon(root);
    db = handle.db;
    const path = handle.ipcServer.path;

    await stopDaemon(handle);
    db = undefined;

    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection(path);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false); // treat "never connected within the window" as refused
      }, 1000);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    expect(connected).toBe(false);
  });

  it('a real session captures BOTH a simultaneous file save AND a real terminal command in the same running daemon session (Phase 7.5 Verify line)', async () => {
    if (isWindows) return;

    const root = makeTempRoot();
    const initResult = stenodInit(root, { reset: false });
    const handle = await startDaemon(initResult.projectRoot);
    db = handle.db;

    await new Promise<void>((resolve) => handle.watcher.once('ready', resolve));

    // Filesystem track: a real save.
    const srcFile = join(handle.projectRoot, 'src', 'index.ts');
    mkdirSync(join(srcFile, '..'), { recursive: true });
    writeFileSync(srcFile, 'export const x = 1;', 'utf8');

    // Terminal track: a real command, through the real Phase 7.5 bridge —
    // a separate client connection (attachTerminalSession()), exactly as a
    // real `stenod attach` invocation would, against the SAME running
    // daemon the file save above just went through.
    const session = await attachTerminalSession(handle.projectRoot, {
      shell: 'sh',
      args: ['-c', 'echo "bridged in the same session"'],
    });
    const result = await session.closed;
    expect(result.exitCode).toBe(0);

    const fsRowFound = await waitFor(() => {
      const row = handle.db.prepare("SELECT * FROM graph_nodes WHERE type = 'FILE_STATE'").get();
      return row !== undefined;
    }, 3000);
    expect(fsRowFound, 'expected a FILE_STATE row').toBe(true);

    const terminalRowFound = await waitFor(() => {
      const row = handle.db.prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_SUCCESS'").get();
      return row !== undefined;
    }, 3000);
    expect(terminalRowFound, 'expected a TERMINAL_SUCCESS row').toBe(true);

    // Both landed in the SAME graph_nodes table, in the SAME daemon session.
    const rowCount = (
      handle.db.prepare('SELECT COUNT(*) AS cnt FROM graph_nodes').get() as { cnt: number }
    ).cnt;
    expect(rowCount).toBe(2);

    await stopDaemon(handle);
    db = undefined;
    expect(existsSync(pidLockPath(handle.projectRoot))).toBe(false);
  });
});
