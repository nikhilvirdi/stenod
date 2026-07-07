import Database from 'better-sqlite3';

/**
 * Opens a better-sqlite3 connection to the given file path and applies the
 * required WAL pragmas as specified in SSOT §6.2:
 *
 *   PRAGMA journal_mode=WAL
 *   PRAGMA synchronous=NORMAL
 *   PRAGMA cache_size=-64000
 *
 * Also enables PRAGMA foreign_keys=ON — SQLite disables FK enforcement by default
 * per connection. Without this, REFERENCES clauses in graph_edges (and any future
 * FK-bearing table) are structural documentation only and never actually enforced.
 * This is a required infrastructure setting for Phase 1.3 "FK constraints active"
 * to be satisfied. It does not contradict Phase 1.1 — it is an additive connection
 * setting that the schema layer depends on.
 *
 * Do NOT create any tables here — that is the responsibility of the schema
 * migration runner (Phase 1.5).
 */
export function openDatabase(filePath: string): Database.Database {
  const db = new Database(filePath);

  // Enable WAL mode for crash-safe concurrent reads/writes without a server process.
  db.pragma('journal_mode=WAL');

  // NORMAL is sufficient when WAL is active; FULL is only needed in DELETE mode.
  db.pragma('synchronous=NORMAL');

  // Negative value = kilobytes. -64000 ≈ 64 MB page cache.
  db.pragma('cache_size=-64000');

  // Required for FK constraints (REFERENCES clauses) to be enforced at runtime.
  // SQLite disables FK enforcement by default per-connection.
  db.pragma('foreign_keys=ON');

  return db;
}
