import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from '../connection.js';
import { createGraphNodesTable } from './graph-nodes.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Phase 1.2 verification tests — graph_nodes table.
 *
 * Done when:
 *   [x] Table creates cleanly
 *   [x] All 9 columns present, correct types
 *   [x] Enum values enforced (CHECK constraints at SQLite level)
 * Verify: `.schema graph_nodes` inspection + insert/select test.
 */

describe('storage/schema/graph-nodes — Phase 1.2', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function setup(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-test-'));
    const dbPath = join(tempDir, 'graph.db');
    db = openDatabase(dbPath);
    createGraphNodesTable(db);
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

  it('has exactly the 9 expected columns in order', () => {
    const conn = setup();
    const columns = conn.pragma('table_info(graph_nodes)') as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toEqual([
      'id',
      'event_id',
      'type',
      'content',
      'fsm_state',
      'constraint_key',
      'status',
      'source_file',
      'created_at',
    ]);
  });

  // ── `type` CHECK constraint ───────────────────────────────────────────────

  it('rejects an invalid `type` value', () => {
    const conn = setup();
    expect(() => {
      conn
        .prepare(
          `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('n1', 1, 'INVALID_TYPE', 'content', 'IDE_IDLE', 'ACTIVE', Date.now());
    }).toThrow(/CHECK constraint failed/i);
  });

  it('accepts all 5 valid `type` values', () => {
    const conn = setup();
    const now = Date.now();
    const stmt = conn.prepare(
      `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    expect(() => stmt.run('n1', 1, 'FILE_STATE', 'c', 'IDE_IDLE', 'ACTIVE', now)).not.toThrow();
    expect(() =>
      stmt.run('n2', 2, 'TERMINAL_ERROR', 'c', 'IDE_IDLE', 'ACTIVE', now)
    ).not.toThrow();
    expect(() =>
      stmt.run('n3', 3, 'TERMINAL_SUCCESS', 'c', 'IDE_IDLE', 'ACTIVE', now)
    ).not.toThrow();
    expect(() =>
      stmt.run('n4', 4, 'PROVIDER_CAPTURE', 'c', 'IDE_IDLE', 'ACTIVE', now)
    ).not.toThrow();
    expect(() => stmt.run('n5', 5, 'CONSTRAINT', 'c', 'IDE_IDLE', 'ACTIVE', now)).not.toThrow();
  });

  // ── `fsm_state` CHECK constraint ─────────────────────────────────────────

  it('rejects an invalid `fsm_state` value', () => {
    const conn = setup();
    expect(() => {
      conn
        .prepare(
          `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('n1', 1, 'FILE_STATE', 'content', 'INVALID_STATE', 'ACTIVE', Date.now());
    }).toThrow(/CHECK constraint failed/i);
  });

  it('accepts all 5 valid `fsm_state` values', () => {
    const conn = setup();
    const now = Date.now();
    const stmt = conn.prepare(
      `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    expect(() => stmt.run('n1', 1, 'FILE_STATE', 'c', 'IDE_IDLE', 'ACTIVE', now)).not.toThrow();
    expect(() => stmt.run('n2', 2, 'FILE_STATE', 'c', 'RUNTIME_ERR', 'ACTIVE', now)).not.toThrow();
    expect(() => stmt.run('n3', 3, 'FILE_STATE', 'c', 'DOC_EDIT', 'ACTIVE', now)).not.toThrow();
    expect(() => stmt.run('n4', 4, 'FILE_STATE', 'c', 'DIFF_SUBMIT', 'ACTIVE', now)).not.toThrow();
    expect(() =>
      stmt.run('n5', 5, 'FILE_STATE', 'c', 'PROVISIONAL_PANIC', 'ACTIVE', now)
    ).not.toThrow();
  });

  // ── `status` CHECK constraint ─────────────────────────────────────────────

  it('rejects an invalid `status` value', () => {
    const conn = setup();
    expect(() => {
      conn
        .prepare(
          `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('n1', 1, 'FILE_STATE', 'content', 'IDE_IDLE', 'INVALID_STATUS', Date.now());
    }).toThrow(/CHECK constraint failed/i);
  });

  it('accepts all 3 valid `status` values', () => {
    const conn = setup();
    const now = Date.now();
    const stmt = conn.prepare(
      `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    expect(() => stmt.run('n1', 1, 'FILE_STATE', 'c', 'IDE_IDLE', 'ACTIVE', now)).not.toThrow();
    expect(() => stmt.run('n2', 2, 'FILE_STATE', 'c', 'IDE_IDLE', 'REJECTED', now)).not.toThrow();
    expect(() =>
      stmt.run('n3', 3, 'FILE_STATE', 'c', 'IDE_IDLE', 'SUPERSEDED', now)
    ).not.toThrow();
  });

  // ── Nullable columns ──────────────────────────────────────────────────────

  it('`constraint_key` accepts NULL', () => {
    const conn = setup();
    expect(() => {
      conn
        .prepare(
          `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at,
                                    constraint_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('n1', 1, 'FILE_STATE', 'content', 'IDE_IDLE', 'ACTIVE', Date.now(), null);
    }).not.toThrow();

    const row = conn
      .prepare('SELECT constraint_key FROM graph_nodes WHERE id = ?')
      .get('n1') as Record<string, unknown>;
    expect(row['constraint_key']).toBeNull();
  });

  it('`source_file` accepts NULL', () => {
    const conn = setup();
    expect(() => {
      conn
        .prepare(
          `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at,
                                    source_file)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('n1', 1, 'FILE_STATE', 'content', 'IDE_IDLE', 'ACTIVE', Date.now(), null);
    }).not.toThrow();

    const row = conn
      .prepare('SELECT source_file FROM graph_nodes WHERE id = ?')
      .get('n1') as Record<string, unknown>;
    expect(row['source_file']).toBeNull();
  });

  // ── Valid insert / select round-trip ──────────────────────────────────────

  it('performs a valid insert and select round-trip with all columns', () => {
    const conn = setup();
    const now = Date.now();

    conn
      .prepare(
        `INSERT INTO graph_nodes
           (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'node-abc',
        42,
        'CONSTRAINT',
        'use PostgreSQL',
        'DOC_EDIT',
        'db-choice',
        'ACTIVE',
        'src/db/index.ts',
        now
      );

    const row = conn
      .prepare('SELECT * FROM graph_nodes WHERE id = ?')
      .get('node-abc') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row['id']).toBe('node-abc');
    expect(row['event_id']).toBe(42);
    expect(row['type']).toBe('CONSTRAINT');
    expect(row['content']).toBe('use PostgreSQL');
    expect(row['fsm_state']).toBe('DOC_EDIT');
    expect(row['constraint_key']).toBe('db-choice');
    expect(row['status']).toBe('ACTIVE');
    expect(row['source_file']).toBe('src/db/index.ts');
    expect(row['created_at']).toBe(now);
  });
});
