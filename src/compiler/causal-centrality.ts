import type Database from 'better-sqlite3';

/**
 * Phase 8.3 — Causal Centrality
 *
 * SSOT §6.4: "causal_centrality is simple in/out-degree within the node's
 * own edge set — cheap, O(V+E), sufficient at realistic single-project
 * graph sizes."
 *
 * Design decision (documented for review, consistent with how Phase 3.3's
 * resolveLwwConflict() and other 1.6-dependent phases operate): this
 * queries the real `graph_edges` table via an open `Database.Database`
 * connection rather than taking an in-memory edge list, matching
 * "Depends on: 1.6" (the fully migrated schema) and making it directly
 * testable against a hand-built fixture graph (real rows in a real temp
 * DB), per the phase's Verify line.
 *
 * "The node's own edge set" means only edges directly touching this node
 * (as `from_node_id` or `to_node_id`) — not a graph traversal beyond that,
 * exactly as SSOT's "simple" and "O(V+E)" language describes.
 *
 * Returns both individual degrees and their sum (`total`) — the single
 * scalar `causal_centrality` value Phase 8.2's utility score formula
 * (`λ2·causal_centrality`) consumes — since the phase's own "Done when"
 * checklist asks for "degree counts" (plural) to be independently
 * verifiable, not just a combined number.
 */

export interface CausalCentrality {
  readonly inDegree: number;
  readonly outDegree: number;
  /** inDegree + outDegree — the causal_centrality value SSOT §6.4 refers to. */
  readonly total: number;
}

/**
 * Computes in-degree, out-degree, and total degree for `nodeId` within its
 * own edge set in `graph_edges`.
 */
export function calculateCausalCentrality(db: Database.Database, nodeId: string): CausalCentrality {
  const inDegree = (
    db.prepare('SELECT COUNT(*) AS cnt FROM graph_edges WHERE to_node_id = ?').get(nodeId) as {
      cnt: number;
    }
  ).cnt;

  const outDegree = (
    db.prepare('SELECT COUNT(*) AS cnt FROM graph_edges WHERE from_node_id = ?').get(nodeId) as {
      cnt: number;
    }
  ).cnt;

  return { inDegree, outDegree, total: inDegree + outDegree };
}
