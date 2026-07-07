import Database from 'better-sqlite3';

/**
 * ENUM VALUES for graph_edges.edge_type — mirrors the DB-level CHECK constraint.
 *
 * Enum enforcement choice (Phase 1.3): CHECK constraints at the SQLite level,
 * consistent with the same decision made in Phase 1.2 for graph_nodes.
 */

export const EDGE_TYPES = ['REPLACES', 'CAUSED_BY', 'CONTRADICTS', 'DEPENDS_ON'] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

/**
 * Creates the graph_edges table.
 *
 * Schema (exact, per SSOT §6.2 and workplan Phase 1.3):
 *
 *   id            TEXT PRIMARY KEY
 *   from_node_id  TEXT NOT NULL  — FK → graph_nodes.id
 *   to_node_id    TEXT NOT NULL  — FK → graph_nodes.id
 *   edge_type     TEXT NOT NULL  — CHECK enforces EdgeType enum
 *   created_at    INTEGER NOT NULL
 *
 * FK enforcement requirement: the caller's connection MUST have
 * PRAGMA foreign_keys=ON active (set by openDatabase in connection.ts).
 * Without it, the REFERENCES clauses below are structural-only and never
 * enforced at runtime.
 *
 * Do NOT create graph_nodes or manifest_log here — those are separate phases.
 * Do NOT add any columns beyond this list.
 */
export function createGraphEdgesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_edges (
      id           TEXT    NOT NULL PRIMARY KEY,
      from_node_id TEXT    NOT NULL REFERENCES graph_nodes(id),
      to_node_id   TEXT    NOT NULL REFERENCES graph_nodes(id),
      edge_type    TEXT    NOT NULL CHECK (edge_type IN ('REPLACES', 'CAUSED_BY', 'CONTRADICTS', 'DEPENDS_ON')),
      created_at   INTEGER NOT NULL
    )
  `);
}
