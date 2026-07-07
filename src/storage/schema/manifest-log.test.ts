import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from '../connection.js';
import { createManifestLogTable } from './manifest-log.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Phase 1.4 verification tests — manifest_log table.
 *
 * Done when:
 *   [x] Table creates cleanly
 *   [x] outcome accepts NULL and both enum values, rejects anything else
 *
 * Verify: insert/select round-trip test including NULL outcome case.
 */

describe('storage/schema/manifest-log — Phase 1.4', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function setup(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-test-'));
    const dbPath = join(tempDir, 'graph.db');
    db = openDatabase(dbPath);
    createManifestLogTable(db);
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

  // ── Schema checks ─────────────────────────────────────────────────────────

  it('table creates cleanly (no error thrown)', () => {
    expect(() => setup()).not.toThrow();
  });

  it('has exactly the 5 expected columns', () => {
    const conn = setup();
    const columns = conn.pragma('table_info(manifest_log)') as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toEqual(['id', 'created_at', 'node_ids', 'token_count', 'outcome']);
  });

  // ── Enum and NULL constraints ──────────────────────────────────────────────

  it('allows NULL value for outcome', () => {
    const conn = setup();
    const now = Date.now();
    const nodeIdsJson = JSON.stringify(['node-1', 'node-2']);

    expect(() => {
      conn
        .prepare(
          `INSERT INTO manifest_log (id, created_at, node_ids, token_count, outcome)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('manifest-1', now, nodeIdsJson, 150, null);
    }).not.toThrow();

    const row = conn
      .prepare('SELECT * FROM manifest_log WHERE id = ?')
      .get('manifest-1') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row['outcome']).toBeNull();
  });

  it('allows WORKED value for outcome', () => {
    const conn = setup();
    const now = Date.now();
    const nodeIdsJson = JSON.stringify(['node-1', 'node-2']);

    expect(() => {
      conn
        .prepare(
          `INSERT INTO manifest_log (id, created_at, node_ids, token_count, outcome)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('manifest-2', now, nodeIdsJson, 150, 'WORKED');
    }).not.toThrow();

    const row = conn
      .prepare('SELECT * FROM manifest_log WHERE id = ?')
      .get('manifest-2') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row['outcome']).toBe('WORKED');
  });

  it('allows FAILED value for outcome', () => {
    const conn = setup();
    const now = Date.now();
    const nodeIdsJson = JSON.stringify(['node-1', 'node-2']);

    expect(() => {
      conn
        .prepare(
          `INSERT INTO manifest_log (id, created_at, node_ids, token_count, outcome)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('manifest-3', now, nodeIdsJson, 150, 'FAILED');
    }).not.toThrow();

    const row = conn
      .prepare('SELECT * FROM manifest_log WHERE id = ?')
      .get('manifest-3') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row['outcome']).toBe('FAILED');
  });

  it('rejects invalid outcome values', () => {
    const conn = setup();
    const now = Date.now();
    const nodeIdsJson = JSON.stringify(['node-1', 'node-2']);

    expect(() => {
      conn
        .prepare(
          `INSERT INTO manifest_log (id, created_at, node_ids, token_count, outcome)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('manifest-4', now, nodeIdsJson, 150, 'INVALID');
    }).toThrow(/CHECK constraint failed/i);
  });

  // ── Valid insert / select round-trip ──────────────────────────────────────

  it('performs valid insert and select round-trip successfully', () => {
    const conn = setup();
    const now = Date.now();
    const nodeIds = ['node-a', 'node-b', 'node-c'];
    const nodeIdsJson = JSON.stringify(nodeIds);

    conn
      .prepare(
        `INSERT INTO manifest_log (id, created_at, node_ids, token_count, outcome)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('manifest-5', now, nodeIdsJson, 320, 'WORKED');

    const row = conn
      .prepare('SELECT * FROM manifest_log WHERE id = ?')
      .get('manifest-5') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row['id']).toBe('manifest-5');
    expect(row['created_at']).toBe(now);
    expect(row['node_ids']).toBe(nodeIdsJson);
    expect(JSON.parse(row['node_ids'] as string)).toEqual(nodeIds);
    expect(row['token_count']).toBe(320);
    expect(row['outcome']).toBe('WORKED');
  });
});
