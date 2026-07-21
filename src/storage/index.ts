import type Database from 'better-sqlite3';

// Storage module boundary
export { openDatabase } from './connection.js';
export {
  createGraphNodesTable,
  NODE_TYPES,
  NODE_STATUSES,
  NODE_RESOLUTIONS,
  insertDecisionNode,
} from './schema/graph-nodes.js';
export type { NodeType, NodeStatus, NodeResolution, DecisionNodeInput } from './schema/graph-nodes.js';
export { createGraphEdgesTable, EDGE_TYPES } from './schema/graph-edges.js';
export type { EdgeType } from './schema/graph-edges.js';
export { createManifestLogTable, MANIFEST_OUTCOMES } from './schema/manifest-log.js';
export type { ManifestOutcome } from './schema/manifest-log.js';
export { runMigrations, CURRENT_SCHEMA_VERSION } from './migrations.js';

/** Monotonic event_id strategy used by capture tracks. */
export function nextEventId(db: Database.Database): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(event_id), 0) + 1 AS next FROM graph_nodes')
    .get() as { next: number };
  return row.next;
}
