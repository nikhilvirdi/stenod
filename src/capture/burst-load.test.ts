import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { writeFileStateNode } from './file-state.js';
import { writeTerminalNode } from './terminal-state.js';
import { IngestionQueue } from './queue.js';

/**
 * Phase 6.3 — Burst-Load Integration Test.
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Zero SQLITE_BUSY errors under the simulated burst
 *   [x] All events accounted for in the DB afterward
 *
 * Scope note (mirrors the precedent set by Phase 1.6's storage.test.ts,
 * which consolidates 1.2-1.5's per-table coverage into one integration-
 * level file rather than editing those already-Verified files): this is a
 * new, dedicated file rather than another addition to queue.test.ts, since
 * WORKPLAN gives 6.3 its own "Build" line (a full integration test) rather
 * than extending queue.ts itself the way 6.2 did. No production code
 * changes — file-state.ts, terminal-state.ts, and queue.ts (Phases 4.4,
 * 5.3, 6.1/6.2, all already Verified) are only imported and called, never
 * modified.
 *
 * "A realistic burst" is built the same way Phases 6.1/6.2 already proved
 * the queue correct — real writeFileStateNode()/writeTerminalNode() calls
 * routed through a real IngestionQueue against a real temp-file SQLite DB
 * — but at the scale and interleave pattern SSOT's example describes ("a
 * git rebase generating many file events plus terminal spam
 * simultaneously"): several hundred file-save events across many distinct
 * paths (many files touched across many rebased commits) interleaved with
 * a smaller but substantial stream of terminal output, all fired without
 * waiting between calls, through a capacity-limited queue (Phase 6.2's
 * maxDepth + disk overflow) so the full Milestone 6 subsystem — not just
 * the base Phase 6.1 queue — is what's actually under test.
 *
 * "Zero SQLITE_BUSY errors" is only a meaningful claim if something could
 * plausibly contend for the database file. A single writer connection
 * serialized through one queue can't contend with itself, so this test
 * also opens a second, independent connection to the same DB file and
 * polls it with real SELECTs throughout the burst — simulating a
 * concurrent reader (e.g. a future `stenod status`) — the actual scenario
 * SSOT's WAL configuration (Phase 1.1) exists to make safe.
 */
describe('capture/queue — Phase 6.3 burst-load integration', () => {
  let tempDir: string;
  let db: Database.Database | undefined;
  let readerDb: Database.Database | undefined;
  let overflowDir: string;

  function migratedDb(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-burst-test-'));
    db = openDatabase(join(tempDir, 'graph.db'));
    runMigrations(db);
    return db;
  }

  afterEach(() => {
    if (readerDb) {
      readerDb.close();
      readerDb = undefined;
    }
    if (db) {
      db.close();
      db = undefined;
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (overflowDir && existsSync(overflowDir)) {
      rmSync(overflowDir, { recursive: true, force: true });
    }
  });

  it("a realistic burst (many file events + terminal spam, fired concurrently, past the queue's maxDepth) produces zero SQLITE_BUSY errors and accounts for every event in the DB", async () => {
    const conn = migratedDb();
    readerDb = openDatabase(join(tempDir, 'graph.db'));
    const fsm = new SessionFsm();
    overflowDir = mkdtempSync(join(tmpdir(), 'stenod-burst-overflow-'));
    // Deliberately smaller than the burst below, so Phase 6.2's overflow
    // path is genuinely exercised, not just the base Phase 6.1 queue.
    const queue = new IngestionQueue({ maxDepth: 25, overflowDir });

    const FILE_EVENTS = 300; // "a git rebase generating many file events"
    const TERMINAL_EVENTS = 150; // "terminal spam"
    const TOTAL = FILE_EVENTS + TERMINAL_EVENTS;

    // Simulates a concurrent reader (e.g. a future `stenod status` poll)
    // hitting the same DB file, on its own connection, throughout the
    // burst — the actual condition under which SQLITE_BUSY could occur.
    const pollErrors: unknown[] = [];
    const pollTimer = setInterval(() => {
      try {
        readerDb!.prepare('SELECT COUNT(*) AS cnt FROM graph_nodes').get();
      } catch (err) {
        pollErrors.push(err);
      }
    }, 2);

    let fileCount = 0;
    let terminalCount = 0;
    const results: Promise<unknown>[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const takeFile = fileCount < FILE_EVENTS && (terminalCount >= TERMINAL_EVENTS || i % 2 === 0);
      if (takeFile) {
        const idx = fileCount;
        fileCount += 1;
        results.push(
          queue.enqueueOverflowable(idx, (n: number) =>
            writeFileStateNode(conn, fsm, `/rebase/file-${n}.ts`, `content for rebased file ${n}`)
          )
        );
      } else {
        const idx = terminalCount;
        terminalCount += 1;
        results.push(
          queue.enqueueOverflowable(idx, (n: number) =>
            writeTerminalNode(conn, fsm, `terminal spam output line ${n}`, n % 7 === 0 ? 1 : 0)
          )
        );
      }
    }

    expect(fileCount).toBe(FILE_EVENTS);
    expect(terminalCount).toBe(TERMINAL_EVENTS);
    // All TOTAL calls above ran synchronously without awaiting between
    // them, so the queue's maxDepth (25) must already have been exceeded —
    // confirms the overflow path (Phase 6.2) is actually in play here.
    expect(queue.overflowDepth).toBeGreaterThan(0);

    const settled = await Promise.allSettled(results);
    clearInterval(pollTimer);

    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => r.reason)).toEqual([]);

    const busySpecific = pollErrors.filter(
      (err) => (err as { code?: string }).code === 'SQLITE_BUSY'
    );
    expect(pollErrors).toEqual([]);
    expect(busySpecific).toEqual([]);

    const rows = conn.prepare('SELECT event_id, type FROM graph_nodes ORDER BY event_id').all() as {
      event_id: number;
      type: string;
    }[];

    expect(rows).toHaveLength(TOTAL);
    expect(rows.map((r) => r.event_id)).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(rows.filter((r) => r.type === 'FILE_STATE')).toHaveLength(FILE_EVENTS);
    expect(
      rows.filter((r) => r.type === 'TERMINAL_SUCCESS' || r.type === 'TERMINAL_ERROR')
    ).toHaveLength(TERMINAL_EVENTS);

    expect(queue.overflowDepth).toBe(0);
    expect(queue.depth).toBe(0);
  });
});
