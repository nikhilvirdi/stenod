import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { tagManifestOutcome } from './feedback.js';

/**
 * Phase 9.3 — Feedback Tagging Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Correct row updated, others untouched
 *
 * Verify line: "test with multiple log rows, confirm only the most
 * recent is affected."
 */
describe('delivery/feedback — Phase 9.3', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function freshDb(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-feedback-test-'));
    db = openDatabase(join(tempDir, 'graph.db'));
    runMigrations(db);
    return db;
  }

  function insertLogRow(
    conn: Database.Database,
    id: string,
    createdAt: number,
    outcome: string | null = null
  ): void {
    conn
      .prepare(
        `INSERT INTO manifest_log (id, created_at, node_ids, token_count, outcome)
         VALUES (?, ?, '[]', 0, ?)`
      )
      .run(id, createdAt, outcome);
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

  it('tags only the most recent row (highest created_at) as WORKED, leaving older rows untouched', () => {
    const conn = freshDb();
    insertLogRow(conn, 'old', 1_000);
    insertLogRow(conn, 'middle', 2_000);
    insertLogRow(conn, 'newest', 3_000);

    const result = tagManifestOutcome(conn, 'WORKED');

    expect(result).toEqual({ updated: true, id: 'newest' });

    const rows = conn
      .prepare('SELECT id, outcome FROM manifest_log ORDER BY created_at ASC')
      .all() as Array<{ id: string; outcome: string | null }>;

    expect(rows).toEqual([
      { id: 'old', outcome: null },
      { id: 'middle', outcome: null },
      { id: 'newest', outcome: 'WORKED' },
    ]);
  });

  it('tags the most recent row as FAILED', () => {
    const conn = freshDb();
    insertLogRow(conn, 'a', 1_000);
    insertLogRow(conn, 'b', 2_000);

    const result = tagManifestOutcome(conn, 'FAILED');

    expect(result).toEqual({ updated: true, id: 'b' });
    expect(conn.prepare('SELECT outcome FROM manifest_log WHERE id = ?').get('b')).toEqual({
      outcome: 'FAILED',
    });
    expect(conn.prepare('SELECT outcome FROM manifest_log WHERE id = ?').get('a')).toEqual({
      outcome: null,
    });
  });

  it('breaks a created_at tie deterministically by insertion order (rowid), not arbitrarily', () => {
    const conn = freshDb();
    // Both rows share the exact same created_at (simulating two handoffs in the same millisecond).
    // 'first' is inserted before 'second', so 'second' has the higher rowid and must win.
    insertLogRow(conn, 'first', 5_000);
    insertLogRow(conn, 'second', 5_000);

    const result = tagManifestOutcome(conn, 'WORKED');

    expect(result).toEqual({ updated: true, id: 'second' });
    expect(conn.prepare('SELECT outcome FROM manifest_log WHERE id = ?').get('first')).toEqual({
      outcome: null,
    });
  });

  it('re-tagging overwrites the same most-recent row rather than duplicating or reverting it', () => {
    const conn = freshDb();
    insertLogRow(conn, 'only', 1_000);

    tagManifestOutcome(conn, 'FAILED');
    const second = tagManifestOutcome(conn, 'WORKED');

    expect(second).toEqual({ updated: true, id: 'only' });
    const rows = conn.prepare('SELECT * FROM manifest_log').all();
    expect(rows).toHaveLength(1);
    expect(conn.prepare('SELECT outcome FROM manifest_log WHERE id = ?').get('only')).toEqual({
      outcome: 'WORKED',
    });
  });

  it('is a no-op on an empty manifest_log table', () => {
    const conn = freshDb();

    const result = tagManifestOutcome(conn, 'WORKED');

    expect(result).toEqual({ updated: false });
    expect(conn.prepare('SELECT COUNT(*) AS cnt FROM manifest_log').get()).toEqual({ cnt: 0 });
  });
});
