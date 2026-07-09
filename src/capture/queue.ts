import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 6.1 — Ingestion Queue ("the Bouncer")
 *
 * SSOT §6.1: "all tracks feed one serialized queue into WAL-SQLite" — a
 * single write path both the filesystem track (Phase 4.4) and the terminal
 * track (Phase 5.3) will eventually funnel through, so that simultaneous
 * events from either stream never interleave at the write layer.
 *
 * Scope note: this module is intentionally standalone and generic — it has
 * no knowledge of `Database`, `graph_nodes`, or the FSM. Rewiring
 * `createFileStateCapture`/`createTerminalCapture` to call through an
 * `IngestionQueue` instance instead of writing directly is Phase 7.2's job
 * ("wiring together the capture tracks (4.x, 5.x) and the ingestion queue
 * (6.x) into one running process" — WORKPLAN Phase 7.2), not this one.
 *
 * Design: an async FIFO serial executor backed by a pending-task array and
 * a `draining` guard, rather than a fully synchronous call-through. This is
 * deliberate even though `better-sqlite3` itself is fully synchronous and
 * Node is single-threaded (so two independent callbacks can never literally
 * interleave mid-write without this queue either) — the Promise-returning
 * shape is what lets Phase 6.2 (shared max in-flight depth, disk-spill
 * overflow) change `enqueue()`'s *internals* later (deferring a task's
 * execution until capacity frees up) without changing its signature or any
 * call site. A synchronous `enqueue<T>(task) => T` cannot express "accepted
 * but not yet run," which backpressure fundamentally requires.
 *
 * There is no timer anywhere in this file — no `setInterval`, nothing to
 * `.unref()` or tear down. Draining is purely microtask-driven: the `await`
 * inside `drain()`'s loop only defers the *next* task's start by one
 * microtask tick, it does not delay the write itself (by the time `await`
 * is reached, the underlying synchronous DB call inside `task()` has
 * already completed). Microtask overhead is on the order of microseconds,
 * far under the 5ms per-event latency budget.
 *
 * Phase 6.2 addition — backpressure / overflow: `enqueue()` above takes an
 * arbitrary opaque closure, which cannot be serialized to disk (functions
 * aren't serializable, and these particular closures also close over a live
 * `Database`/FSM connection). SSOT §6.1's "overflow spills to an append-only
 * disk buffer, drained FIFO" therefore needs a *second*, capacity-aware
 * entry point — `enqueueOverflowable()` — that takes plain, JSON-
 * serializable item data plus a reusable executor function, so only the
 * item itself (not the executor) gets written to disk. `enqueue()` is left
 * completely unchanged: it is not capacity-limited and never spills,
 * exactly as it behaved when Phase 6.1 was verified.
 *
 * Once more than `maxDepth` items are resident in `pending`, further
 * `enqueueOverflowable()` calls append `{ id, item }` as a line of NDJSON to
 * a single on-disk file (`overflow.ndjson` inside the caller-supplied
 * `overflowDir`) instead of holding the item in the JS heap — the file is
 * only ever appended to, never rewritten, matching "append-only". The small
 * `{ resolve, reject, execute }` waiter for that call *is* kept in memory
 * (functions can't be spilled), correlated back to its item by `id` when
 * read back — but the potentially large `item` payload itself (e.g. file
 * content) is dropped from the JS heap the moment it's durably on disk.
 * `drain()` tops `pending` back up from the overflow file, one line at a
 * time, strictly in the order they were written (append order == read
 * order in an append-only file), whenever a slot frees up — so overflowed
 * items still execute in exact FIFO order relative to everything else,
 * never dropped, never reordered.
 */

export type QueueTask<T> = () => T | Promise<T>;
export type OverflowExecutor<T, R> = (item: T) => R | Promise<R>;

export interface IngestionQueueOptions {
  /**
   * Max number of items held resident in memory (waiting in `pending`)
   * before further `enqueueOverflowable()` calls spill to disk instead.
   * Only applies to `enqueueOverflowable()` — `enqueue()` is never capped
   * or spilled, since its closures cannot be serialized. Omitted/undefined
   * means unlimited (no overflow ever occurs).
   */
  maxDepth?: number;
  /**
   * Directory for the append-only overflow file. Required whenever
   * `maxDepth` is set — there would otherwise be nowhere to spill to.
   */
  overflowDir?: string;
}

interface PendingEntry {
  run: () => Promise<void>;
}

interface OverflowWaiter {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  execute: OverflowExecutor<unknown, unknown>;
}

export class IngestionQueue {
  private readonly pending: PendingEntry[] = [];
  private draining = false;
  private inFlight = 0;

  private readonly maxDepth: number;
  private readonly overflowDir: string | undefined;
  private overflowFilePath: string | undefined;
  private overflowLinesWritten = 0;
  private overflowLinesRead = 0;
  private nextOverflowId = 0;
  private readonly overflowWaiters = new Map<number, OverflowWaiter>();

  constructor(options: IngestionQueueOptions = {}) {
    if (options.maxDepth !== undefined && !options.overflowDir) {
      throw new Error('IngestionQueue: overflowDir is required when maxDepth is set');
    }
    this.maxDepth = options.maxDepth ?? Infinity;
    this.overflowDir = options.overflowDir;
  }

  /**
   * Accepted-but-not-yet-settled task/item count, across both `enqueue()`
   * and `enqueueOverflowable()` — the "shared" part of SSOT §6.1's "shared
   * max in-flight depth". Increments synchronously on enqueue, decrements
   * only once that call's Promise has settled (resolved or rejected).
   */
  get depth(): number {
    return this.inFlight;
  }

  /** Items currently spilled to disk, written but not yet read back and run. */
  get overflowDepth(): number {
    return this.overflowLinesWritten - this.overflowLinesRead;
  }

  enqueue<T>(task: QueueTask<T>): Promise<T> {
    this.inFlight += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run: async () => {
          try {
            resolve(await task());
          } catch (err) {
            reject(err);
          } finally {
            this.inFlight -= 1;
          }
        },
      });
      void this.drain();
    });
  }

  /**
   * Capacity-aware alternative to `enqueue()`: `item` must be JSON-
   * serializable (it may be written to disk); `execute` is a plain function
   * reference (not serialized) applied to `item` once it actually runs,
   * whether it stayed resident or was read back from the overflow file.
   */
  enqueueOverflowable<T, R>(item: T, execute: OverflowExecutor<T, R>): Promise<R> {
    this.inFlight += 1;
    return new Promise<R>((resolve, reject) => {
      const waiter: OverflowWaiter = {
        resolve: resolve as (value: unknown) => void,
        reject,
        execute: execute as OverflowExecutor<unknown, unknown>,
      };
      try {
        if (this.pending.length < this.maxDepth) {
          this.pending.push(this.makeEntry(item, waiter));
        } else {
          this.spillToDisk(item, waiter);
        }
      } catch (err) {
        this.inFlight -= 1;
        reject(err);
        return;
      }
      void this.drain();
    });
  }

  private makeEntry(item: unknown, waiter: OverflowWaiter): PendingEntry {
    return {
      run: async () => {
        try {
          waiter.resolve(await waiter.execute(item));
        } catch (err) {
          waiter.reject(err);
        } finally {
          this.inFlight -= 1;
        }
      },
    };
  }

  private spillToDisk(item: unknown, waiter: OverflowWaiter): void {
    const id = this.nextOverflowId;
    this.nextOverflowId += 1;
    this.overflowWaiters.set(id, waiter);
    const filePath = this.ensureOverflowFile();
    appendFileSync(filePath, `${JSON.stringify({ id, item })}\n`, 'utf8');
    this.overflowLinesWritten += 1;
  }

  private ensureOverflowFile(): string {
    if (!this.overflowFilePath) {
      // Constructor already guarantees overflowDir is set whenever maxDepth
      // (and therefore spillToDisk) is reachable.
      mkdirSync(this.overflowDir as string, { recursive: true });
      this.overflowFilePath = join(this.overflowDir as string, 'overflow.ndjson');
    }
    return this.overflowFilePath;
  }

  /** Pulls overflowed items back into `pending`, in write (FIFO) order, while there's room. */
  private refillFromOverflow(): void {
    while (
      this.pending.length < this.maxDepth &&
      this.overflowLinesRead < this.overflowLinesWritten
    ) {
      const content = readFileSync(this.overflowFilePath as string, 'utf8');
      const lines = content.split('\n').filter((line) => line.length > 0);
      const raw = lines[this.overflowLinesRead];
      this.overflowLinesRead += 1;
      const { id, item } = JSON.parse(raw) as { id: number; item: unknown };
      const waiter = this.overflowWaiters.get(id);
      this.overflowWaiters.delete(id);
      if (!waiter) continue;
      this.pending.push(this.makeEntry(item, waiter));
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        this.refillFromOverflow();
        const entry = this.pending.shift();
        if (!entry) break;
        await entry.run();
      }
    } finally {
      this.draining = false;
    }
  }
}
