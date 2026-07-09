import type { PackableNode, GreedyPackResult } from './greedy-packing.js';

/**
 * Phase 8.5 — Local Improvement Pass
 *
 * SSOT §6.4, step 5 of the compilation algorithm (steps 1-4 are Phase
 * 8.4's `packByGreedyRatio()`, already complete by the time this runs):
 *   "Local improvement pass: for the lowest-value included node, check
 *    whether swapping it for the highest-value excluded node that still
 *    fits improves total value. Repeat until no improving swap exists."
 *
 * "This is a standard, cheap heuristic upgrade to plain greedy — no
 * O(n²·1/ε) DP matrix needed."
 *
 * Design decisions (documented for review):
 * -----------------------------------------------------------------------
 * - CONSTRAINT nodes are never candidates for removal — they were
 *   force-included "regardless of score" by Phase 8.4 (the primacy zone,
 *   non-negotiable), so it would directly contradict that to evict one
 *   here just because it has a low utility score. Only non-CONSTRAINT
 *   members of `included` are considered "the lowest-value included
 *   node."
 * - Each iteration re-evaluates the *current* lowest-value included node
 *   and the *current* highest-value excluded node that fits in the space
 *   freed by removing it — exactly the single swap SSOT describes, not a
 *   search over all possible pairs (that would be the more expensive
 *   approach SSOT explicitly says this heuristic avoids). If that
 *   specific swap doesn't improve value, the pass stops — "no improving
 *   swap exists" is evaluated for the lowest node each iteration, per the
 *   algorithm's own literal, single-target-per-iteration description.
 * - "The highest-value excluded node that still fits" is the max-value
 *   node among all excluded nodes whose tokenCost fits within the budget
 *   freed by removing the current lowest node (not literally "the single
 *   highest-value excluded node overall, checked once and given up on if
 *   it doesn't fit") — otherwise a smaller-but-still-improving node would
 *   never be tried, and "repeat until no improving swap exists" would be
 *   far too easy to satisfy prematurely.
 * - "Improves total value" requires the candidate's utilityScore to be
 *   strictly greater than the node it would replace — a swap that doesn't
 *   increase total value isn't a swap SSOT calls "improving."
 * - Termination: since every successful swap strictly increases total
 *   value (by construction — the replacement always has a higher score
 *   than what it replaces) and there is only a finite number of distinct
 *   achievable included-sets, the loop is guaranteed to terminate on its
 *   own once no improving swap remains. `MAX_ITERATIONS` below is a
 *   defensive backstop only — not the primary termination mechanism — to
 *   satisfy "Done when: Pass terminates (no infinite loop)" even under an
 *   unforeseen bug, not because the algorithm is expected to need it.
 * - Ties (equal utilityScore, or equal ratio during the min/max scan) are
 *   broken deterministically by original array position — the first node
 *   encountered with a given extreme value wins, never a later one, so
 *   repeated runs on identical input always produce identical output.
 */

export interface LocalImprovementResult extends GreedyPackResult {
  /** Number of improving swaps actually performed. */
  swapCount: number;
}

/**
 * Generous, non-tight safety cap on iterations — real termination happens
 * via the "no improving swap found" break below; see this file's header
 * comment for why this bound is a backstop, not the intended mechanism.
 */
function maxIterationsFor(result: GreedyPackResult): number {
  return result.included.length + result.excluded.length + 1;
}

/** Index (in `included`) of the lowest-utilityScore non-CONSTRAINT node, or -1 if none exists. */
function findLowestIncludedIndex(included: PackableNode[]): number {
  let lowIdx = -1;
  let lowScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < included.length; i++) {
    const node = included[i];
    if (node.type === 'CONSTRAINT') continue;
    if (node.utilityScore < lowScore) {
      lowScore = node.utilityScore;
      lowIdx = i;
    }
  }
  return lowIdx;
}

/** Index (in `excluded`) of the highest-utilityScore node that both fits `availableTokens` and strictly beats `mustExceedScore`, or -1. */
function findBestFittingExcludedIndex(
  excluded: PackableNode[],
  availableTokens: number,
  mustExceedScore: number
): number {
  let bestIdx = -1;
  let bestScore = mustExceedScore;
  for (let i = 0; i < excluded.length; i++) {
    const node = excluded[i];
    if (node.tokenCost > availableTokens) continue;
    if (node.utilityScore > bestScore) {
      bestScore = node.utilityScore;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Applies SSOT §6.4's local improvement pass to a Phase 8.4
 * `packByGreedyRatio()` result: repeatedly swaps the lowest-value included
 * (non-CONSTRAINT) node for the highest-value excluded node that fits in
 * the freed space and strictly improves total value, until no such swap
 * remains.
 */
export function applyLocalImprovementPass(
  packResult: GreedyPackResult,
  tokenBudget: number
): LocalImprovementResult {
  const included = [...packResult.included];
  const excluded = [...packResult.excluded];
  let totalTokens = packResult.totalTokens;
  let swapCount = 0;

  const maxIterations = maxIterationsFor(packResult);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const lowIdx = findLowestIncludedIndex(included);
    if (lowIdx === -1) break; // nothing swappable (empty or constraints-only)

    const lowNode = included[lowIdx];
    const availableTokens = tokenBudget - (totalTokens - lowNode.tokenCost);

    const highIdx = findBestFittingExcludedIndex(excluded, availableTokens, lowNode.utilityScore);
    if (highIdx === -1) break; // no improving swap exists for the current lowest node

    const highNode = excluded[highIdx];

    included[lowIdx] = highNode;
    excluded[highIdx] = lowNode;
    totalTokens = totalTokens - lowNode.tokenCost + highNode.tokenCost;
    swapCount += 1;
  }

  return { included, excluded, totalTokens, swapCount };
}
