import Database from 'better-sqlite3';

/**
 * ENUM VALUES for manifest_log.outcome — mirrors the DB-level CHECK constraint.
 *
 * Enum enforcement choice (Phase 1.4): CHECK constraints at the SQLite level,
 * consistent with the same decision made in Phase 1.2 and 1.3.
 */

export const MANIFEST_OUTCOMES = ['WORKED', 'FAILED'] as const;

export type ManifestOutcome = (typeof MANIFEST_OUTCOMES)[number];

/**
 * Creates the manifest_log table.
 *
 * Schema (exact, per SSOT §6.2 and workplan Phase 1.4):
 *
 *   id            TEXT PRIMARY KEY        — unique identifier
 *   created_at    INTEGER NOT NULL        — epoch ms
 *   node_ids      TEXT NOT NULL           — JSON array of node IDs selected into this manifest
 *   token_count   INTEGER NOT NULL        — total token cost
 *   outcome       TEXT                    — ENUM nullable CHECK ('WORKED', 'FAILED')
 *
 * Do NOT create graph_nodes, graph_edges or any other table here.
 * Do NOT add columns beyond this list.
 */
export function createManifestLogTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manifest_log (
      id          TEXT    NOT NULL PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      node_ids    TEXT    NOT NULL,
      token_count INTEGER NOT NULL,
      outcome     TEXT    CHECK (outcome IS NULL OR outcome IN ('WORKED', 'FAILED'))
    )
  `);
}
