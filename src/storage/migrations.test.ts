import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from './connection.js';
import { runMigrations, CURRENT_SCHEMA_VERSION } from './migrations.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Phase 1.5 verification tests — Schema Versioning / Migration Runner.
 *
 * Done when:
 *   [x] Fresh DB ends at the current expected version after migrations run
 *   [x] Runner is idempotent — running it twice doesn't double-apply or error
 *
 * Verify: test simulating an older user_version, confirm migration runs
 * exactly once and lands at current version.
 */

describe('storage/migrations — Phase 1.5', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function freshDb(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-test-'));
    const dbPath = join(tempDir, 'graph.db');
    db = openDatabase(dbPath);
    return db;
  }

  afterEach(() => {
    if (db) {
      db.close();
      db = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── Fresh DB lands at CURRENT_SCHEMA_VERSION ──────────────────────────────

  it('fresh DB starts at user_version 0 before migrations run', () => {
    const conn = freshDb();
    const version = conn.pragma('user_version', { simple: true });
    expect(version).toBe(0);
  });

  it('fresh DB ends at CURRENT_SCHEMA_VERSION after runMigrations()', () => {
    const conn = freshDb();
    runMigrations(conn);
    const version = conn.pragma('user_version', { simple: true });
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('CURRENT_SCHEMA_VERSION is a positive integer', () => {
    expect(Number.isInteger(CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  // ── All three tables exist after migration ────────────────────────────────

  it('graph_nodes table exists after migration', () => {
    const conn = freshDb();
    runMigrations(conn);
    const tables = conn
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='graph_nodes'`)
      .get();
    expect(tables).toBeDefined();
  });

  it('graph_edges table exists after migration', () => {
    const conn = freshDb();
    runMigrations(conn);
    const tables = conn
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='graph_edges'`)
      .get();
    expect(tables).toBeDefined();
  });

  it('manifest_log table exists after migration', () => {
    const conn = freshDb();
    runMigrations(conn);
    const tables = conn
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='manifest_log'`)
      .get();
    expect(tables).toBeDefined();
  });

  // ── Idempotency ───────────────────────────────────────────────────────────

  it('running runMigrations() twice does not throw', () => {
    const conn = freshDb();
    expect(() => {
      runMigrations(conn);
      runMigrations(conn);
    }).not.toThrow();
  });

  it('running runMigrations() twice leaves version at CURRENT_SCHEMA_VERSION', () => {
    const conn = freshDb();
    runMigrations(conn);
    runMigrations(conn);
    const version = conn.pragma('user_version', { simple: true });
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('running runMigrations() twice does not duplicate tables', () => {
    const conn = freshDb();
    runMigrations(conn);
    runMigrations(conn);
    // If CREATE TABLE IF NOT EXISTS is idempotent, this count should always be 1.
    const count = (
      conn
        .prepare(
          `SELECT COUNT(*) as cnt FROM sqlite_master
           WHERE type='table' AND name IN ('graph_nodes','graph_edges','manifest_log')`
        )
        .get() as { cnt: number }
    ).cnt;
    expect(count).toBe(3);
  });

  // ── Simulating an older user_version (key spec requirement) ───────────────

  it('DB at user_version 0 (older) is migrated up to CURRENT_SCHEMA_VERSION', () => {
    const conn = freshDb();
    // Simulate a DB that was created before any migrations ran — user_version stays 0.
    // (fresh DB is already at 0; this test makes the intent explicit.)
    conn.exec('PRAGMA user_version = 0');
    expect(conn.pragma('user_version', { simple: true })).toBe(0);

    runMigrations(conn);

    expect(conn.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('DB already at CURRENT_SCHEMA_VERSION does not re-apply migrations', () => {
    const conn = freshDb();

    // Run once to fully migrate.
    runMigrations(conn);
    expect(conn.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);

    // Drop a table to prove it won't be re-created (migration was skipped).
    conn.exec('DROP TABLE manifest_log');

    // Run again — should be a no-op because version is already current.
    runMigrations(conn);

    // manifest_log should still be gone — migration was NOT re-applied.
    const table = conn
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='manifest_log'`)
      .get();
    expect(table).toBeUndefined();
  });
});
