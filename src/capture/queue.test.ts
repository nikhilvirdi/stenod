/**
 * Phase 6.1 — Ingestion Queue ("the Bouncer") Tests
 *
 * SSOT §6.1 / WORKPLAN Phase 6.1 "Done when" checklist:
 *   [x] Simultaneous fs + terminal events are written without interleaving
 *       corruption
 *   [x] Write latency under 5ms per event under normal load
 *
 * Three tiers:
 *   1. Unit-level (no DB) — proves the serialization/ordering/reentrancy
 *      contract of IngestionQueue in isolation.
 *   2. Integration-level — real writes via the already-Verified
 *      writeFileStateNode()/writeTerminalNode() (imported read-only, not
 *      modified) against a real temp-file SQLite DB, proving interleaved
 *      fs+terminal writes through the queue produce correct, uncorrupted
 *      rows.
 *   3. Latency benchmark — satisfies the <5ms-per-event checklist item via
 *      average + p95 assertions (not a strict per-sample max, to avoid
 *      CI flakiness from GC/scheduler jitter — confirmed as the intended
 *      reading of "under 5ms per event under normal load").
 */

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

describe('capture/queue — Phase 6.1', () => {
  // ── Tier 1: unit-level, no DB ───────────────────────────────────────────

  describe('serialization contract (no DB)', () => {
    it("enqueue resolves with the task's return value", async () => {
      const queue = new IngestionQueue();
      const result = await queue.enqueue(() => 42);
      expect(result).toBe(42);
    });

    it('FIFO ordering holds even when an earlier task is slower than a later one', async () => {
      const order: string[] = [];
      let releaseA: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const queue = new IngestionQueue();

      const resultA = queue.enqueue(async () => {
        order.push('A-start');
        await gate;
        order.push('A-end');
        return 'a';
      });
      const resultB = queue.enqueue(() => {
        order.push('B-start');
        return 'b';
      });

      // A's synchronous prefix has already run by now (enqueue() drains
      // synchronously up to the first suspension point); B must still be
      // waiting behind it in the queue.
      expect(order).toEqual(['A-start']);

      releaseA();
      const [a, b] = await Promise.all([resultA, resultB]);

      expect(a).toBe('a');
      expect(b).toBe('b');
      expect(order).toEqual(['A-start', 'A-end', 'B-start']);
    });

    it("a rejected task's error propagates only to its own caller; the queue keeps draining", async () => {
      const queue = new IngestionQueue();

      const badResult = queue.enqueue(() => {
        throw new Error('boom');
      });
      const goodResult = queue.enqueue(() => 'ok');

      await expect(badResult).rejects.toThrow('boom');
      await expect(goodResult).resolves.toBe('ok');
    });

    it('reentrant enqueue() from inside a running task is inserted into FIFO order at the point it was called', async () => {
      const order: string[] = [];
      const queue = new IngestionQueue();

      const resultA = queue.enqueue(() => {
        order.push('A');
        // Reentrant: registered while A is still executing, before B below
        // has been enqueued from the top level.
        queue.enqueue(() => {
          order.push('C');
          return 'c';
        });
      });
      const resultB = queue.enqueue(() => {
        order.push('B');
        return 'b';
      });

      await Promise.all([resultA, resultB]);

      // C was pushed onto the queue before B (during A's synchronous
      // execution), so strict FIFO insertion order runs it before B.
      expect(order).toEqual(['A', 'C', 'B']);
    });

    it('depth increments per enqueue and decrements only as each task settles', async () => {
      const queue = new IngestionQueue();
      let releaseA: () => void = () => {};
      let releaseB: () => void = () => {};
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const gateB = new Promise<void>((resolve) => {
        releaseB = resolve;
      });

      expect(queue.depth).toBe(0);

      const resultA = queue.enqueue(async () => {
        await gateA;
        return 'a';
      });
      expect(queue.depth).toBe(1);

      const resultB = queue.enqueue(async () => {
        await gateB;
        return 'b';
      });
      expect(queue.depth).toBe(2);

      releaseA();
      await resultA;
      expect(queue.depth).toBe(1);

      releaseB();
      await resultB;
      expect(queue.depth).toBe(0);
    });
  });

  // ── Tier 2 + 3: real writes against a real temp-file SQLite DB ─────────

  describe('real writes through the queue', () => {
    let tempDir: string;
    let db: Database.Database | undefined;

    function migratedDb(): Database.Database {
      tempDir = mkdtempSync(join(tmpdir(), 'stenod-queue-test-'));
      db = openDatabase(join(tempDir, 'graph.db'));
      runMigrations(db);
      return db;
    }

    afterEach(() => {
      if (db) {
        db.close();
        db = undefined;
      }
      if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('interleaved fs + terminal writes fired through the queue without waiting for each to settle produce exactly N correct, uniquely-numbered graph_nodes rows', async () => {
      const conn = migratedDb();
      const fsm = new SessionFsm();
      const queue = new IngestionQueue();
      const N = 50;

      const results: Promise<unknown>[] = [];
      for (let i = 0; i < N; i++) {
        if (i % 2 === 0) {
          results.push(
            queue.enqueue(() => writeFileStateNode(conn, fsm, `/proj/file-${i}.ts`, `content-${i}`))
          );
        } else {
          results.push(
            queue.enqueue(() => writeTerminalNode(conn, fsm, `term-${i}`, i % 4 === 1 ? 0 : 1))
          );
        }
      }

      await Promise.all(results);

      const rows = conn
        .prepare('SELECT event_id, type, content FROM graph_nodes ORDER BY event_id')
        .all() as { event_id: number; type: string; content: string }[];

      expect(rows).toHaveLength(N);
      expect(rows.map((r) => r.event_id)).toEqual(Array.from({ length: N }, (_, i) => i + 1));

      for (let i = 0; i < N; i++) {
        const row = rows[i];
        if (i % 2 === 0) {
          expect(row.type).toBe('FILE_STATE');
          expect(row.content).toBe(`content-${i}`);
        } else {
          expect(['TERMINAL_SUCCESS', 'TERMINAL_ERROR']).toContain(row.type);
          expect(row.content).toBe(`term-${i}`);
        }
      }
    });

    it('resulting event_id assignment matches enqueue call order, not task completion order', async () => {
      const conn = migratedDb();
      const fsm = new SessionFsm();
      const queue = new IngestionQueue();

      function delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      const callOrder = ['fast-0', 'slow-1', 'fast-2', 'slow-3', 'fast-4'];
      const results = callOrder.map((label, i) => {
        if (label.startsWith('slow')) {
          return queue
            .enqueue(async () => {
              await delay(15);
              return writeFileStateNode(conn, fsm, `/slow-${i}.ts`, `slow-content-${i}`);
            })
            .then((r) => ({ label, eventId: r.eventId }));
        }
        return queue
          .enqueue(() => writeFileStateNode(conn, fsm, `/fast-${i}.ts`, `fast-content-${i}`))
          .then((r) => ({ label, eventId: r.eventId }));
      });

      const settled = await Promise.all(results);
      const orderedByEventId = [...settled]
        .sort((a, b) => a.eventId - b.eventId)
        .map((s) => s.label);

      expect(orderedByEventId).toEqual(callOrder);
    });

    it('queue.depth returns to 0 after a full interleaved fs+terminal burst settles', async () => {
      const conn = migratedDb();
      const fsm = new SessionFsm();
      const queue = new IngestionQueue();

      const results = Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? queue.enqueue(() => writeFileStateNode(conn, fsm, `/d-${i}.ts`, `d-${i}`))
          : queue.enqueue(() => writeTerminalNode(conn, fsm, `d-${i}`, 0))
      );

      expect(queue.depth).toBeGreaterThan(0);
      await Promise.all(results);
      expect(queue.depth).toBe(0);
    });

    it('per-event enqueue-to-resolution latency stays under budget under a representative burst (average + p95 under 5ms)', async () => {
      const conn = migratedDb();
      const fsm = new SessionFsm();
      const queue = new IngestionQueue();
      // "Normal load" here means a handful of genuinely simultaneous fs +
      // terminal events (e.g. a save landing around the same time as a
      // command's exit) — not a saturating flood. A FIFO queue's tail
      // latency necessarily scales with how many events are already queued
      // ahead of it, so an unrealistically large burst (hundreds of writes
      // fired in the same synchronous tick) would measure queueing backlog
      // rather than per-event write cost, and belongs to Phase 6.2/6.3's
      // backpressure/burst-load territory, not this phase's baseline check.
      const N = 10;

      const latenciesMs: number[] = new Array(N).fill(0);
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < N; i++) {
        const start = process.hrtime.bigint();
        const p =
          i % 2 === 0
            ? queue.enqueue(() => writeFileStateNode(conn, fsm, `/lat-${i}.ts`, `lat-content-${i}`))
            : queue.enqueue(() => writeTerminalNode(conn, fsm, `lat-term-${i}`, 0));
        tasks.push(
          p.then(() => {
            latenciesMs[i] = Number(process.hrtime.bigint() - start) / 1e6;
          })
        );
      }

      await Promise.all(tasks);

      const average = latenciesMs.reduce((a, b) => a + b, 0) / N;
      const sorted = [...latenciesMs].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(N * 0.95)];

      expect(average).toBeLessThan(5);
      expect(p95).toBeLessThan(5);
    });

    it('a single isolated event (no contention) resolves in well under 5ms', async () => {
      const conn = migratedDb();
      const fsm = new SessionFsm();
      const queue = new IngestionQueue();

      const start = process.hrtime.bigint();
      await queue.enqueue(() => writeFileStateNode(conn, fsm, '/solo.ts', 'solo-content'));
      const ms = Number(process.hrtime.bigint() - start) / 1e6;

      expect(ms).toBeLessThan(5);
    });
  });
});
