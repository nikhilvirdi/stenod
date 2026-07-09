// Compiler module boundary — implementation begins in Phase 8.x

// Phase 8.2 — utility score calculation: v_i = λ1·decay(Δt) + λ2·causal_centrality + λ3·constraint_priority.
export { calculateUtilityScore, UTILITY_SCORE_WEIGHTS } from './utility-score.js';
export type { UtilityScoreInput } from './utility-score.js';

// Phase 8.3 — causal centrality: simple in/out-degree within a node's own edge set.
export { calculateCausalCentrality } from './causal-centrality.js';
export type { CausalCentrality } from './causal-centrality.js';

// Phase 8.4 — greedy-by-ratio packing: force-include CONSTRAINT nodes, pack the rest by v_i/token_cost.
export { packByGreedyRatio } from './greedy-packing.js';
export type { PackableNode, GreedyPackResult } from './greedy-packing.js';
