import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from '../connection.js';
import { createGraphNodesTable, insertDecisionNode } from './graph-nodes.js';
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

  it('has exactly the 11 expected columns in order (Phase 16.1 adds resolution, resolution_reason)', () => {
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
      'resolution',
      'resolution_reason',
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

  it('accepts `DECISION` as a valid `type` value (Phase 16.1)', () => {
    const conn = setup();
    const now = Date.now();
    expect(() =>
      conn
        .prepare(
          `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('n1', 1, 'DECISION', 'c', 'IDE_IDLE', 'ACTIVE', now)
    ).not.toThrow();
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

  // ── `resolution` CHECK constraint (Phase 16.1) ────────────────────────────

  it('`resolution` accepts NULL (non-DECISION nodes leave it unset)', () => {
    const conn = setup();
    expect(() => {
      conn
        .prepare(
          `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('n1', 1, 'FILE_STATE', 'content', 'IDE_IDLE', 'ACTIVE', Date.now());
    }).not.toThrow();

    const row = conn
      .prepare('SELECT resolution FROM graph_nodes WHERE id = ?')
      .get('n1') as Record<string, unknown>;
    expect(row['resolution']).toBeNull();
  });

  it('rejects an invalid `resolution` value', () => {
    const conn = setup();
    expect(() => {
      conn
        .prepare(
          `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at, resolution)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('n1', 1, 'DECISION', 'content', 'IDE_IDLE', 'ACTIVE', Date.now(), 'INVALID_RESOLUTION');
    }).toThrow(/CHECK constraint failed/i);
  });

  it('accepts all 3 valid `resolution` values', () => {
    const conn = setup();
    const now = Date.now();
    const stmt = conn.prepare(
      `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at, resolution)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    expect(() =>
      stmt.run('n1', 1, 'DECISION', 'c', 'IDE_IDLE', 'ACTIVE', now, 'SETTLED')
    ).not.toThrow();
    expect(() =>
      stmt.run('n2', 2, 'DECISION', 'c', 'IDE_IDLE', 'ACTIVE', now, 'REJECTED')
    ).not.toThrow();
    expect(() =>
      stmt.run('n3', 3, 'DECISION', 'c', 'IDE_IDLE', 'ACTIVE', now, 'OPEN')
    ).not.toThrow();
  });

  it('`resolution_reason` accepts NULL', () => {
    const conn = setup();
    expect(() => {
      conn
        .prepare(
          `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at,
                                    resolution, resolution_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('n1', 1, 'DECISION', 'content', 'IDE_IDLE', 'ACTIVE', Date.now(), 'OPEN', null);
    }).not.toThrow();

    const row = conn
      .prepare('SELECT resolution_reason FROM graph_nodes WHERE id = ?')
      .get('n1') as Record<string, unknown>;
    expect(row['resolution_reason']).toBeNull();
  });

  // ── `insertDecisionNode` — application-layer enforcement (Phase 16.1) ─────

  it('creates a DECISION node with resolution SETTLED', () => {
    const conn = setup();
    const now = Date.now();
    insertDecisionNode(conn, {
      id: 'd1',
      eventId: 1,
      content: 'use PostgreSQL',
      fsmState: 'DOC_EDIT',
      status: 'ACTIVE',
      resolution: 'SETTLED',
      createdAt: now,
    });

    const row = conn
      .prepare('SELECT * FROM graph_nodes WHERE id = ?')
      .get('d1') as Record<string, unknown>;
    expect(row['type']).toBe('DECISION');
    expect(row['resolution']).toBe('SETTLED');
    expect(row['resolution_reason']).toBeNull();
  });

  it('creates a DECISION node with resolution OPEN', () => {
    const conn = setup();
    insertDecisionNode(conn, {
      id: 'd1',
      eventId: 1,
      content: 'which cache layer to use',
      fsmState: 'IDE_IDLE',
      status: 'ACTIVE',
      resolution: 'OPEN',
      createdAt: Date.now(),
    });

    const row = conn
      .prepare('SELECT resolution FROM graph_nodes WHERE id = ?')
      .get('d1') as Record<string, unknown>;
    expect(row['resolution']).toBe('OPEN');
  });

  it('creates a DECISION node with resolution REJECTED and a reason', () => {
    const conn = setup();
    insertDecisionNode(conn, {
      id: 'd1',
      eventId: 1,
      content: 'use MongoDB',
      fsmState: 'DOC_EDIT',
      status: 'ACTIVE',
      resolution: 'REJECTED',
      resolutionReason: 'team standardized on relational storage',
      createdAt: Date.now(),
    });

    const row = conn
      .prepare('SELECT resolution, resolution_reason FROM graph_nodes WHERE id = ?')
      .get('d1') as Record<string, unknown>;
    expect(row['resolution']).toBe('REJECTED');
    expect(row['resolution_reason']).toBe('team standardized on relational storage');
  });

  it('rejects a REJECTED resolution without a resolution_reason', () => {
    const conn = setup();
    expect(() =>
      insertDecisionNode(conn, {
        id: 'd1',
        eventId: 1,
        content: 'use MongoDB',
        fsmState: 'DOC_EDIT',
        status: 'ACTIVE',
        resolution: 'REJECTED',
        createdAt: Date.now(),
      })
    ).toThrow(/resolution_reason is required/i);

    const row = conn.prepare('SELECT * FROM graph_nodes WHERE id = ?').get('d1');
    expect(row).toBeUndefined();
  });

  it('rejects a REJECTED resolution with an empty-string resolution_reason', () => {
    const conn = setup();
    expect(() =>
      insertDecisionNode(conn, {
        id: 'd1',
        eventId: 1,
        content: 'use MongoDB',
        fsmState: 'DOC_EDIT',
        status: 'ACTIVE',
        resolution: 'REJECTED',
        resolutionReason: '',
        createdAt: Date.now(),
      })
    ).toThrow(/resolution_reason is required/i);
  });
});
