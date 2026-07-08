import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Phase 3.3 — LWW (Last-Writer-Wins) Conflict Resolution
 *
 * SSOT §6.3:
 *   "Conflict resolution (Last-Writer-Wins, built in): a new CONSTRAINT
 *    node sharing a constraint_key with an ACTIVE constraint draws a
 *    CONTRADICTS edge to it and flips the old node to SUPERSEDED.
 *    The compiler excludes anything not ACTIVE, unconditionally."
 *
 * Design decisions (documented for review):
 * ------------------------------------------
 * - This function is called AFTER the new CONSTRAINT node has been inserted
 *   into graph_nodes. It does not insert the new node itself — separation
 *   of concerns: the insert path is the caller's responsibility, the conflict
 *   resolution is this function's.
 *
 * - The entire conflict resolution (query + edge insert + status flip) runs
 *   inside a single SQLite transaction so it's atomic. Either all conflicting
 *   nodes are superseded and edges created, or none are.
 *
 * - Edge IDs use crypto.randomUUID() — the SSOT specifies TEXT PK for edges
 *   but does not require content-hash IDs (that's only for graph_nodes).
 *
 * - If multiple ACTIVE nodes share the same constraint_key (e.g. from a
 *   bug or manual edit), ALL of them are superseded and get CONTRADICTS
 *   edges — not just the most recent one. This is defensive: LWW's whole
 *   point is that the newest writer wins unconditionally.
 *
 * DOES NOT: insert the new CONSTRAINT node, interact with the FSM, or
 * touch any capture/compiler logic.
 */

/** Result returned by resolveLwwConflict(). */
export interface LwwResult {
  /** Number of previously-ACTIVE nodes that were superseded. */
  readonly supersededCount: number;
  /** IDs of the CONTRADICTS edges created. */
  readonly edgeIds: readonly string[];
}

/**
 * Resolves LWW conflicts for a newly inserted CONSTRAINT node.
 *
 * For every existing ACTIVE CONSTRAINT node with the same `constraintKey`:
 *   1. Creates a CONTRADICTS edge from `newNodeId` → that node.
 *   2. Flips that node's status from ACTIVE to SUPERSEDED.
 *
 * @param db           — Open better-sqlite3 database connection (must have
 *                       FK enforcement ON and schema already migrated).
 * @param newNodeId    — The id of the newly inserted CONSTRAINT node.
 * @param constraintKey — The constraint_key value to check for conflicts.
 *
 * @returns An LwwResult with the count of superseded nodes and edge IDs.
 *
 * If no existing ACTIVE node shares this constraintKey, this is a no-op
 * and returns { supersededCount: 0, edgeIds: [] }.
 */
export function resolveLwwConflict(
  db: Database.Database,
  newNodeId: string,
  constraintKey: string,
): LwwResult {
  const edgeIds: string[] = [];

  const resolveAll = db.transaction(() => {
    // Find all ACTIVE CONSTRAINT nodes with the same constraint_key,
    // excluding the new node itself (it was just inserted as ACTIVE).
    const existing = db
      .prepare(
        `SELECT id FROM graph_nodes
         WHERE type = 'CONSTRAINT'
           AND status = 'ACTIVE'
           AND constraint_key = ?
           AND id != ?`,
      )
      .all(constraintKey, newNodeId) as Array<{ id: string }>;

    const now = Date.now();

    for (const row of existing) {
      // 1. Create a CONTRADICTS edge: new node → old node.
      const edgeId = randomUUID();
      db.prepare(
        `INSERT INTO graph_edges (id, from_node_id, to_node_id, edge_type, created_at)
         VALUES (?, ?, ?, 'CONTRADICTS', ?)`,
      ).run(edgeId, newNodeId, row.id, now);

      // 2. Flip the old node's status to SUPERSEDED.
      db.prepare(
        `UPDATE graph_nodes SET status = 'SUPERSEDED' WHERE id = ?`,
      ).run(row.id);

      edgeIds.push(edgeId);
    }
  });

  resolveAll();

  return {
    supersededCount: edgeIds.length,
    edgeIds,
  };
}
