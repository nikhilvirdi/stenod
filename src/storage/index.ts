// Storage module boundary
export { openDatabase } from './connection.js';
export { createGraphNodesTable, NODE_TYPES, FSM_STATES, NODE_STATUSES } from './schema/graph-nodes.js';
export type { NodeType, FsmState, NodeStatus } from './schema/graph-nodes.js';
export { createGraphEdgesTable, EDGE_TYPES } from './schema/graph-edges.js';
export type { EdgeType } from './schema/graph-edges.js';
export { createManifestLogTable, MANIFEST_OUTCOMES } from './schema/manifest-log.js';
export type { ManifestOutcome } from './schema/manifest-log.js';
export { runMigrations, CURRENT_SCHEMA_VERSION } from './migrations.js';
