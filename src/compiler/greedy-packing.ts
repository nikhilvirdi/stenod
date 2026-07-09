import type { NodeType, NodeStatus } from '../storage/index.js';

/**
 * Phase 8.4 — Greedy-by-Ratio Packing
 *
 * SSOT §6.4, steps 1-4 of the compilation algorithm (step 5, the local
 * improvement pass, is Phase 8.5's separate scope, not this one's):
 *   1. Traverse graph, drop anything status != ACTIVE.
 *   2. Force-include all CONSTRAINT nodes -> primacy zone, regardless of
 *      score.
 *   3. Sort remaining nodes by v_i / token_cost descending.
 *   4. Pack until the token budget is hit.
 *
 * "Dantzig's greedy-by-ratio is provably optimal for the *fractional*
 * knapsack problem — it carries no formal optimality guarantee for 0/1
 * knapsack" (SSOT §6.4). This implements the standard 0/1 heuristic: a
 * single pass over nodes sorted by ratio descending, including each node
 * that still fits in the *remaining* budget and skipping (not stopping
 * at) ones that don't — so a later, smaller node can still be picked up
 * after an earlier, larger one was skipped. Stopping at the first miss
 * would leave budget on the table for no reason SSOT asks for.
 *
 * Design decisions (documented for review):
 * -----------------------------------------------------------------------
 * - This is a pure function over an already-assembled list of nodes, each
 *   carrying its precomputed `utilityScore` (Phase 8.2) and `tokenCost`
 *   (Phase 8.1) — it does not query the DB or compute those values itself,
 *   matching "Depends on: 8.1, 8.2, 8.3" (all three are per-node
 *   computation utilities, not DB-querying orchestrators) and the Verify
 *   line's "fixture graph" (a hand-built array of nodes, not a live DB).
 * - Constraint nodes are force-included only after the status filter (step
 *   1 happens before step 2 in SSOT's own ordering) — a SUPERSEDED or
 *   REJECTED node is dropped even if its `type` is CONSTRAINT. "Force-
 *   included regardless of score" means they bypass the ratio-sort
 *   selection process entirely, not that they bypass the ACTIVE-status
 *   filter.
 * - A `tokenCost` of 0 sorts as an infinite ratio (always prioritized
 *   first among non-constraint nodes) rather than producing `Infinity/0 =
 *   NaN` when `utilityScore` also happens to be 0 — NaN comparisons are
 *   unordered and would make the sort's result non-deterministic, which
 *   conflicts with CLAUDE.md's determinism requirement. Not a named SSOT
 *   requirement, a defensive correctness measure for a degenerate but
 *   reachable input (a node with empty content).
 * - Known limitation, not specially handled: if force-included CONSTRAINT
 *   nodes alone exceed `tokenBudget`, `totalTokens` will exceed it too —
 *   SSOT states constraints are included "regardless of score" with no
 *   stated exception for this case, and inventing truncation logic for it
 *   isn't asked for by this phase's Build line.
 */

export interface PackableNode {
  id: string;
  type: NodeType;
  status: NodeStatus;
  /** v_i — Phase 8.2's calculateUtilityScore() output for this node. */
  utilityScore: number;
  /** Phase 8.1's countTokens() output for this node's content. */
  tokenCost: number;
}

export interface GreedyPackResult {
  /** CONSTRAINT nodes (in input order) followed by packed nodes (ratio descending). */
  included: PackableNode[];
  /** Sum of tokenCost across every node in `included`. */
  totalTokens: number;
  /** ACTIVE, non-CONSTRAINT nodes considered but not packed (didn't fit). */
  excluded: PackableNode[];
}

function utilityRatio(node: PackableNode): number {
  if (node.tokenCost === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return node.utilityScore / node.tokenCost;
}

/**
 * Selects nodes for the manifest's packed middle zone: drops non-ACTIVE
 * nodes, force-includes all (ACTIVE) CONSTRAINT nodes, then greedily packs
 * the remaining ACTIVE nodes by utility/token ratio until `tokenBudget` is
 * exhausted — never exceeding it.
 */
export function packByGreedyRatio(nodes: PackableNode[], tokenBudget: number): GreedyPackResult {
  const active = nodes.filter((node) => node.status === 'ACTIVE');
  const constraints = active.filter((node) => node.type === 'CONSTRAINT');
  const candidates = active.filter((node) => node.type !== 'CONSTRAINT');

  const included: PackableNode[] = [...constraints];
  let totalTokens = constraints.reduce((sum, node) => sum + node.tokenCost, 0);

  const sorted = [...candidates].sort((a, b) => utilityRatio(b) - utilityRatio(a));

  const excluded: PackableNode[] = [];
  for (const node of sorted) {
    if (totalTokens + node.tokenCost <= tokenBudget) {
      included.push(node);
      totalTokens += node.tokenCost;
    } else {
      excluded.push(node);
    }
  }

  return { included, totalTokens, excluded };
}
