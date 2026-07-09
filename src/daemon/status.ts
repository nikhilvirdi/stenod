import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pidLockPath, stenoDir, isProcessAlive } from '../workspace/sandbox.js';
import { openDatabase, runMigrations } from '../storage/index.js';

/**
 * Phase 7.3 — `stenod status`
 *
 * SSOT §5: "stenod status | Daemon health, node count, last event
 * timestamp."
 * WORKPLAN Build line: "reports daemon health, node count, last event
 * timestamp."
 *
 * Scope note (Do NOT, by the same precedent Phases 7.1/7.2 state
 * explicitly for their own entries): builds the underlying status-reading
 * function only — no `commander` CLI command, no IPC/socket query against
 * a live daemon (Phase 2.3's scope). Status is derived entirely by reading
 * on-disk state (the Phase 2.1 PID lock file + the SQLite DB), which is
 * safe to do concurrently with a running daemon — WAL mode (Phase 1.1)
 * allows concurrent readers alongside the daemon's own writer connection,
 * already exercised by Phase 6.3's burst-load test.
 *
 * Design decisions (documented for review):
 * -----------------------------------------------------------------------
 * - "Daemon health" is reported as a single `running: boolean` (true only
 *   when the PID lock file exists AND its PID is a live process — the same
 *   liveness definition Phase 2.1's `attachWorkspace()` uses to decide
 *   whether a root is already locked). A stale lock (dead PID) correctly
 *   reports `running: false`, matching Phase 2.1's own stale-lock
 *   semantics, without inventing a separate "stale" status value SSOT
 *   doesn't ask for.
 *   runMigrations()` (Phase 1.5, idempotent) is called before querying,
 *   guaranteeing the tables exist rather than throwing on "no such table."
 */

export interface DaemonStatus {
  /** True only if a live process holds the Phase 2.1 PID lock for this root. */
  running: boolean;
  /** PID of the running daemon, if `running` is true. */
  pid: number | undefined;
  /** Total row count in `graph_nodes`. */
  nodeCount: number;
  /** `created_at` (epoch ms) of the most recent `graph_nodes` row, if any. */
  lastEventAt: number | undefined;
}



/**
 * Reads the current daemon status for `projectRoot` directly from disk
 * (PID lock file + SQLite DB) — does not require a running daemon to be
 * reachable, and is safe to call while one is running.
 */
export function getDaemonStatus(projectRoot: string): DaemonStatus {
  const resolvedRoot = resolve(projectRoot);
  const lockPath = pidLockPath(resolvedRoot);

  let running = false;
  let pid: number | undefined;
  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const candidatePid = parseInt(raw, 10);
    if (Number.isInteger(candidatePid) && candidatePid > 0 && isProcessAlive(candidatePid)) {
      running = true;
      pid = candidatePid;
    }
  }

  let nodeCount = 0;
  let lastEventAt: number | undefined;
  const dbPath = join(stenoDir(resolvedRoot), 'graph.db');
  if (existsSync(dbPath)) {
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);
      nodeCount = (db.prepare('SELECT COUNT(*) AS cnt FROM graph_nodes').get() as { cnt: number })
        .cnt;
      const row = db.prepare('SELECT MAX(created_at) AS maxTs FROM graph_nodes').get() as {
        maxTs: number | null;
      };
      lastEventAt = row.maxTs ?? undefined;
    } finally {
      db.close();
    }
  }

  return { running, pid, nodeCount, lastEventAt };
}
