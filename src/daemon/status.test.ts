import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { writeFileStateNode } from '../capture/file-state.js';
import { writeTerminalNode } from '../capture/terminal-state.js';
import { attachWorkspace, detachWorkspace, stenoDir, pidLockPath } from '../workspace/sandbox.js';
import { getDaemonStatus } from './status.js';

/**
 * Phase 7.3 — `stenod status` Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Status output matches actual DB state
 *
 * Verify line: "compare status output against a direct DB query" — tests
 * 2/3 below do exactly this: run the same COUNT(*)/MAX(created_at) queries
 * directly against the DB and assert getDaemonStatus() returns identical
 * values, rather than just asserting a hardcoded expected number.
 *
 * "Daemon health" (`running`) is exercised via attachWorkspace() directly
 * (using this test process's own PID, which is guaranteed alive) rather
 * than a full startDaemon() — startDaemon() also spawns a terminal via
 * node-pty, which is Unix/Mac-only per SSOT and would make these tests
 * unrunnable on Windows for no reason relevant to what's being tested here
 * (status only reads the PID lock file, it never talks to node-pty).
 */
describe('daemon/status — Phase 7.3', () => {
  const tempDirs: string[] = [];
  let db: Database.Database | undefined;

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-status-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // Already closed — fine.
      }
      db = undefined;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fresh, never-initialized directory reports not running and zero nodes', () => {
    const root = makeTempRoot();

    const status = getDaemonStatus(root);

    expect(status.running).toBe(false);
    expect(status.pid).toBeUndefined();
    expect(status.nodeCount).toBe(0);
    expect(status.lastEventAt).toBeUndefined();
  });

  it('nodeCount and lastEventAt match a direct DB query when no daemon is running', () => {
    const root = makeTempRoot();
    mkdirSync(stenoDir(root), { recursive: true });
    db = openDatabase(join(stenoDir(root), 'graph.db'));
    runMigrations(db);
    const fsm = new SessionFsm();

    writeFileStateNode(db, fsm, '/a.ts', 'aaa');
    writeFileStateNode(db, fsm, '/b.ts', 'bbb');
    writeTerminalNode(db, fsm, 'build ok', 0);

    const status = getDaemonStatus(root);

    const directCount = (
      db.prepare('SELECT COUNT(*) AS cnt FROM graph_nodes').get() as { cnt: number }
    ).cnt;
    const directMaxTs = (
      db.prepare('SELECT MAX(created_at) AS maxTs FROM graph_nodes').get() as {
        maxTs: number | null;
      }
    ).maxTs;

    expect(status.nodeCount).toBe(directCount);
    expect(status.nodeCount).toBe(3);
    expect(status.lastEventAt).toBe(directMaxTs);
    expect(status.running).toBe(false);
  });

  it('reports running:true with the correct pid when a live daemon holds the lock', () => {
    const root = makeTempRoot();
    const resolvedRoot = attachWorkspace(root); // uses this test process's own (live) PID

    try {
      const status = getDaemonStatus(resolvedRoot);

      expect(status.running).toBe(true);
      expect(status.pid).toBe(process.pid);
    } finally {
      detachWorkspace(resolvedRoot);
    }
  });

  it('reports running:false for a stale lock file (dead PID)', () => {
    const root = makeTempRoot();
    // Same convention as workspace/sandbox.test.ts's stale-lock test:
    // MAX_INT_32 is guaranteed not to correspond to a live process.
    const deadPid = 2147483647;
    mkdirSync(stenoDir(root), { recursive: true });
    writeFileSync(pidLockPath(root), String(deadPid), 'utf8');

    const status = getDaemonStatus(root);

    expect(status.running).toBe(false);
    expect(status.pid).toBeUndefined();
  });

  it('reports running:false for a corrupt lock file (non-integer content)', () => {
    const root = makeTempRoot();
    mkdirSync(stenoDir(root), { recursive: true });
    writeFileSync(pidLockPath(root), 'not-a-pid', 'utf8');

    const status = getDaemonStatus(root);

    expect(status.running).toBe(false);
    expect(status.pid).toBeUndefined();
  });

  it('status is safe to read while a live daemon (lock) and populated DB coexist', () => {
    const root = makeTempRoot();
    const resolvedRoot = attachWorkspace(root);
    db = openDatabase(join(stenoDir(resolvedRoot), 'graph.db'));
    runMigrations(db);
    const fsm = new SessionFsm();
    writeFileStateNode(db, fsm, '/live.ts', 'live content');

    try {
      const status = getDaemonStatus(resolvedRoot);

      expect(status.running).toBe(true);
      expect(status.pid).toBe(process.pid);
      expect(status.nodeCount).toBe(1);
      expect(status.lastEventAt).toBeDefined();
      expect(existsSync(pidLockPath(resolvedRoot))).toBe(true);
    } finally {
      detachWorkspace(resolvedRoot);
    }
  });
});
