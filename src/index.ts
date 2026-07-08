// Main entry point for stenod
export * from './capture/index.js';
// `storage` and `lifecycle` each independently define FSM_STATES/FsmState
// (Phase 1.2 predates Phase 3.1's lifecycle module, so storage's DB-schema
// enum was never wired to it). `export *` on both would be ambiguous, so
// storage's copy is re-exported explicitly here, omitting FSM_STATES/FsmState
// and letting lifecycle's `export *` below supply those two names instead.
export {
  openDatabase,
  createGraphNodesTable,
  NODE_TYPES,
  NODE_STATUSES,
  createGraphEdgesTable,
  EDGE_TYPES,
  createManifestLogTable,
  MANIFEST_OUTCOMES,
  runMigrations,
  CURRENT_SCHEMA_VERSION,
} from './storage/index.js';
export type { NodeType, NodeStatus, EdgeType, ManifestOutcome } from './storage/index.js';
export * from './compiler/index.js';
export * from './cli/index.js';
export * from './delivery/index.js';
export * from './workspace/index.js';
export * from './lifecycle/index.js';
