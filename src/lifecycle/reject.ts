import type Database from 'better-sqlite3';

/**
 * Phase 3.4 — Time-Windowed Rejection Logic
 *
 * SSOT §6.3:
 *   "Rejection: stenod reject --since 15m — time-windowed to match FSM
 *    session boundaries, not arbitrary node counts. A pure graph-metadata
 *    operation (status = REJECTED); verifying deletion from the filesystem
 *    is git's job, not this system's — rebuilding version control would be
 *    redundant."
 *
 * Design decisions:
 * - Parses basic duration strings (s = seconds, m = minutes, h = hours).
 * - Only flips ACTIVE nodes to REJECTED. Nodes that are already SUPERSEDED
 *   or REJECTED remain untouched.
 * - Accepts an optional `nowMs` parameter for deterministic testing of the
 *   time boundary.
 */

/**
 * Parses a duration string like "15m", "30s", "2h" into milliseconds.
 * Throws an error on invalid formats.
 */
export function parseDurationToMs(duration: string): number {
  const match = duration.match(/^(\d+)([smh])$/);
  if (!match) {
    throw new Error(
      `stenod reject: Invalid duration format "${duration}". Expected format like 15m, 30s, or 2h.`,
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    default:
      // Unreachable due to regex, but satisfies TS
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Marks all ACTIVE nodes created within the last `duration` window as REJECTED.
 *
 * Takes an open better-sqlite3 connection (`db`), a string `duration` like
 * "15m", and an optional `nowMs` reference time (defaults to Date.now(),
 * used to deterministically test the window boundary).
 *
 * Returns the number of nodes that were successfully rejected.
 */
export function rejectSince(
  db: Database.Database,
  duration: string,
  nowMs: number = Date.now(),
): number {
  const windowMs = parseDurationToMs(duration);
  const cutoff = nowMs - windowMs;

  const result = db
    .prepare(
      `UPDATE graph_nodes
       SET status = 'REJECTED'
       WHERE status = 'ACTIVE'
         AND created_at >= ?`,
    )
    .run(cutoff);

  return result.changes;
}
