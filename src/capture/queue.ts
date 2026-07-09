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
 */

export type QueueTask<T> = () => T | Promise<T>;

interface PendingEntry {
  run: () => Promise<void>;
}

export class IngestionQueue {
  private readonly pending: PendingEntry[] = [];
  private draining = false;
  private inFlight = 0;

  /**
   * Accepted-but-not-yet-settled task count. Increments synchronously on
   * `enqueue()`, decrements only once that task's Promise has settled
   * (resolved or rejected) — not `pending.length`, which would undercount
   * the task currently executing (already shifted off the array) but not
   * yet settled.
   */
  get depth(): number {
    return this.inFlight;
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

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const entry = this.pending.shift();
        if (!entry) break;
        await entry.run();
      }
    } finally {
      this.draining = false;
    }
  }
}
