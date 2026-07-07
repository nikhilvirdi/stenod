import Database from 'better-sqlite3';
import { createGraphNodesTable } from './schema/graph-nodes.js';
import { createGraphEdgesTable } from './schema/graph-edges.js';
import { createManifestLogTable } from './schema/manifest-log.js';

/**
 * Migration runner for Phase 1.5 — Schema Versioning.
 *
 * SSOT §6.2: "Schema version tracked via PRAGMA user_version;
 * stenod start runs pending migrations before attaching."
 *
 * Design choice (documented for review):
 * -------------------------------------------
 * Migrations are represented as a plain ordered array of { version, up }
 * objects, where `version` is the integer the DB will be at after running
 * `up`. This is the simplest representation that satisfies the spec:
 *   - Order is unambiguous (array index + version field).
 *   - Adding a future migration is one array push — no file system scanning,
 *     no naming convention to enforce.
 *   - "Pending" = migrations whose `version` > current PRAGMA user_version.
 *   - After applying each migration, user_version is set immediately, so a
 *     crash mid-sequence leaves the DB at the last successfully applied
 *     version rather than at 0.
 *   - The runner wraps the entire sequence in a single transaction so it is
 *     atomic: either all pending migrations apply, or none do.
 *
 * Current version history:
 *   0 → 1  Create graph_nodes, graph_edges, manifest_log (Phases 1.2–1.4)
 *
 * CURRENT_SCHEMA_VERSION is exported so tests and callers can assert
 * exactly what version a fresh DB should end at.
 */

export const CURRENT_SCHEMA_VERSION = 1;

interface Migration {
  /** The user_version value the database will be at after this migration runs. */
  version: number;
  /** DDL/DML to apply. Receives the open db connection. */
  up: (db: Database.Database) => void;
}

/**
 * All migrations in ascending version order.
 * Do NOT reorder, remove, or modify existing entries — add new entries at
 * the end only. Each entry's `version` must equal its position + 1.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      // Phases 1.2, 1.3, 1.4: create the three core tables.
      // graph_edges has a FK to graph_nodes, so graph_nodes must be created first.
      createGraphNodesTable(db);
      createGraphEdgesTable(db);
      createManifestLogTable(db);
    },
  },
];

/**
 * Runs all pending migrations against `db` in a single transaction, then
 * sets PRAGMA user_version to CURRENT_SCHEMA_VERSION.
 *
 * "Pending" = any migration whose `version` > the current PRAGMA user_version.
 *
 * Idempotent: calling this on a DB already at CURRENT_SCHEMA_VERSION is a
 * no-op (the pending list is empty, the transaction is a no-op commit).
 *
 * Called by the daemon startup path before attaching any capture or compiler
 * logic, per SSOT §6.2: "stenod start runs pending migrations before attaching."
 */
export function runMigrations(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    return;
  }

  // Run all pending migrations atomically. If any step throws, SQLite rolls
  // back the transaction and user_version stays at its pre-call value.
  const applyAll = db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
      // Note: db.exec() is used here instead of db.pragma() because better-sqlite3
      // does not support .pragma() calls inside a transaction callback.
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
  });

  applyAll();
}
