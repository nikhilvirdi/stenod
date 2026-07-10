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

// Phase 8.5 — local improvement pass: swap the lowest-value included node for a higher-value excluded one that fits.
export { applyLocalImprovementPass } from './local-improvement.js';
export type { LocalImprovementResult } from './local-improvement.js';

// Phase 8.6 — U-shaped output structuring: constraints (primacy) -> packed causal graph (middle) -> resume instruction (recency).
export { assembleUShapedManifest } from './u-shaped-manifest.js';
export type { UShapedManifest, RecencyZone } from './u-shaped-manifest.js';

// Phase 8.7 — "Next Actions" block: surfaces the FSM's current unresolved (RUNTIME_ERR) state in the recency zone.
export { generateNextActionsBlock, withNextActionsBlock } from './next-actions.js';
export type {
  NextActionsInput,
  NextActionsBlock,
  RecencyZoneWithNextActions,
} from './next-actions.js';

// Phase 8.9 — DB-to-manifest orchestrator: wires 8.1-8.7 to real graph_nodes/graph_edges rows.
export { compileManifest } from './db-to-manifest.js';
export type { CompileManifestParams, CompiledManifest } from './db-to-manifest.js';
