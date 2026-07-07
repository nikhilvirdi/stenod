import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrations.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Phase 1.6 — Storage Round-Trip Tests (integration level).
 *
 * Interpretation choice (documented for review):
 * -----------------------------------------------
 * The existing per-table test files (graph-nodes.test.ts, graph-edges.test.ts,
 * manifest-log.test.ts) cover table creation and INSERT/SELECT. They are kept
 * intact. This file extends coverage at the integration level:
 *   - All three tables are created through runMigrations() — the same path the
 *     daemon uses — rather than individual createXxxTable() calls.
 *   - Adds full UPDATE and DELETE coverage for all three tables; these are the
 *     CRUD operations the per-table files do not cover at all.
 *   - Exercises cross-table interactions (FK enforcement, cascade behavior) in a
 *     realistic three-table environment.
 *
 * SSOT §6.2 reference: graph_nodes, graph_edges, manifest_log schemas.
 */

describe('storage — Phase 1.6 integration (full CRUD)', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  /** Boot a fully-migrated DB the same way the daemon will. */
  function migratedDb(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-test-'));
    const dbPath = join(tempDir, 'graph.db');
    db = openDatabase(dbPath);
    runMigrations(db);
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

  // ── Helpers ───────────────────────────────────────────────────────────────

  function insertNode(
    conn: Database.Database,
    id: string,
    overrides: Partial<{
      event_id: number;
      type: string;
      content: string;
      fsm_state: string;
      constraint_key: string | null;
      status: string;
      source_file: string | null;
      created_at: number;
    }> = {}
  ): void {
    const v = {
      event_id: 1,
      type: 'FILE_STATE',
      content: 'content',
      fsm_state: 'IDE_IDLE',
      constraint_key: null,
      status: 'ACTIVE',
      source_file: null,
      created_at: Date.now(),
      ...overrides,
    };
    conn
      .prepare(
        `INSERT INTO graph_nodes
           (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        v.event_id,
        v.type,
        v.content,
        v.fsm_state,
        v.constraint_key,
        v.status,
        v.source_file,
        v.created_at
      );
  }

  function insertEdge(
    conn: Database.Database,
    id: string,
    from_node_id: string,
    to_node_id: string,
    edge_type: string = 'CAUSED_BY'
  ): void {
    conn
      .prepare(
        `INSERT INTO graph_edges (id, from_node_id, to_node_id, edge_type, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, from_node_id, to_node_id, edge_type, Date.now());
  }

  function insertManifest(
    conn: Database.Database,
    id: string,
    node_ids: string[],
    token_count: number = 100,
    outcome: string | null = null
  ): void {
    conn
      .prepare(
        `INSERT INTO manifest_log (id, created_at, node_ids, token_count, outcome)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, Date.now(), JSON.stringify(node_ids), token_count, outcome);
  }

  // ── graph_nodes: full CRUD ────────────────────────────────────────────────

  it('graph_nodes: INSERT and SELECT round-trip via migrated DB', () => {
    const conn = migratedDb();
    const now = Date.now();
    insertNode(conn, 'n1', {
      type: 'CONSTRAINT',
      content: 'use PostgreSQL',
      fsm_state: 'DOC_EDIT',
      constraint_key: 'db-choice',
      status: 'ACTIVE',
      source_file: 'src/db/index.ts',
      created_at: now,
    });

    const row = conn
      .prepare('SELECT * FROM graph_nodes WHERE id = ?')
      .get('n1') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row['id']).toBe('n1');
    expect(row['type']).toBe('CONSTRAINT');
    expect(row['content']).toBe('use PostgreSQL');
    expect(row['fsm_state']).toBe('DOC_EDIT');
    expect(row['constraint_key']).toBe('db-choice');
    expect(row['status']).toBe('ACTIVE');
    expect(row['source_file']).toBe('src/db/index.ts');
    expect(row['created_at']).toBe(now);
  });

  it('graph_nodes: UPDATE status from ACTIVE to REJECTED', () => {
    const conn = migratedDb();
    insertNode(conn, 'n1', { status: 'ACTIVE' });

    conn.prepare(`UPDATE graph_nodes SET status = 'REJECTED' WHERE id = ?`).run('n1');

    const row = conn
      .prepare('SELECT status FROM graph_nodes WHERE id = ?')
      .get('n1') as Record<string, unknown>;
    expect(row['status']).toBe('REJECTED');
  });

  it('graph_nodes: UPDATE status to SUPERSEDED', () => {
    const conn = migratedDb();
    insertNode(conn, 'n1', { status: 'ACTIVE' });

    conn.prepare(`UPDATE graph_nodes SET status = 'SUPERSEDED' WHERE id = ?`).run('n1');

    const row = conn
      .prepare('SELECT status FROM graph_nodes WHERE id = ?')
      .get('n1') as Record<string, unknown>;
    expect(row['status']).toBe('SUPERSEDED');
  });

  it('graph_nodes: UPDATE constraint_key', () => {
    const conn = migratedDb();
    insertNode(conn, 'n1', { type: 'CONSTRAINT', constraint_key: 'db-choice' });

    conn
      .prepare(`UPDATE graph_nodes SET constraint_key = 'db-choice-v2' WHERE id = ?`)
      .run('n1');

    const row = conn
      .prepare('SELECT constraint_key FROM graph_nodes WHERE id = ?')
      .get('n1') as Record<string, unknown>;
    expect(row['constraint_key']).toBe('db-choice-v2');
  });

  it('graph_nodes: UPDATE rejects invalid status value', () => {
    const conn = migratedDb();
    insertNode(conn, 'n1');

    expect(() => {
      conn.prepare(`UPDATE graph_nodes SET status = 'INVALID' WHERE id = ?`).run('n1');
    }).toThrow(/CHECK constraint failed/i);
  });

  it('graph_nodes: DELETE removes the row', () => {
    const conn = migratedDb();
    insertNode(conn, 'n1');

    conn.prepare('DELETE FROM graph_nodes WHERE id = ?').run('n1');

    const row = conn.prepare('SELECT * FROM graph_nodes WHERE id = ?').get('n1');
    expect(row).toBeUndefined();
  });

  it('graph_nodes: SELECT returns undefined for nonexistent id', () => {
    const conn = migratedDb();
    const row = conn.prepare('SELECT * FROM graph_nodes WHERE id = ?').get('does-not-exist');
    expect(row).toBeUndefined();
  });

  // ── graph_edges: full CRUD ────────────────────────────────────────────────

  it('graph_edges: INSERT and SELECT round-trip', () => {
    const conn = migratedDb();
    const now = Date.now();
    insertNode(conn, 'na');
    insertNode(conn, 'nb');

    conn
      .prepare(
        `INSERT INTO graph_edges (id, from_node_id, to_node_id, edge_type, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('e1', 'na', 'nb', 'REPLACES', now);

    const row = conn
      .prepare('SELECT * FROM graph_edges WHERE id = ?')
      .get('e1') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row['from_node_id']).toBe('na');
    expect(row['to_node_id']).toBe('nb');
    expect(row['edge_type']).toBe('REPLACES');
    expect(row['created_at']).toBe(now);
  });

  it('graph_edges: UPDATE edge_type', () => {
    const conn = migratedDb();
    insertNode(conn, 'na');
    insertNode(conn, 'nb');
    insertEdge(conn, 'e1', 'na', 'nb', 'CAUSED_BY');

    conn.prepare(`UPDATE graph_edges SET edge_type = 'DEPENDS_ON' WHERE id = ?`).run('e1');

    const row = conn
      .prepare('SELECT edge_type FROM graph_edges WHERE id = ?')
      .get('e1') as Record<string, unknown>;
    expect(row['edge_type']).toBe('DEPENDS_ON');
  });

  it('graph_edges: UPDATE rejects invalid edge_type', () => {
    const conn = migratedDb();
    insertNode(conn, 'na');
    insertNode(conn, 'nb');
    insertEdge(conn, 'e1', 'na', 'nb');

    expect(() => {
      conn.prepare(`UPDATE graph_edges SET edge_type = 'INVALID' WHERE id = ?`).run('e1');
    }).toThrow(/CHECK constraint failed/i);
  });

  it('graph_edges: DELETE removes the edge row', () => {
    const conn = migratedDb();
    insertNode(conn, 'na');
    insertNode(conn, 'nb');
    insertEdge(conn, 'e1', 'na', 'nb');

    conn.prepare('DELETE FROM graph_edges WHERE id = ?').run('e1');

    const row = conn.prepare('SELECT * FROM graph_edges WHERE id = ?').get('e1');
    expect(row).toBeUndefined();
  });

  it('graph_edges: FK blocks INSERT when from_node_id is absent', () => {
    const conn = migratedDb();
    expect(() => insertEdge(conn, 'e1', 'nonexistent', 'also-nonexistent')).toThrow(
      /FOREIGN KEY constraint failed/i
    );
  });

  it('graph_edges: FK blocks INSERT when to_node_id is absent', () => {
    const conn = migratedDb();
    insertNode(conn, 'na');
    expect(() => insertEdge(conn, 'e1', 'na', 'nonexistent')).toThrow(
      /FOREIGN KEY constraint failed/i
    );
  });

  it('graph_edges: FK blocks DELETE of a graph_node referenced by an edge', () => {
    const conn = migratedDb();
    insertNode(conn, 'na');
    insertNode(conn, 'nb');
    insertEdge(conn, 'e1', 'na', 'nb');

    // Deleting 'na' while 'e1' references it as from_node_id must fail.
    expect(() => {
      conn.prepare('DELETE FROM graph_nodes WHERE id = ?').run('na');
    }).toThrow(/FOREIGN KEY constraint failed/i);
  });

  // ── manifest_log: full CRUD ───────────────────────────────────────────────

  it('manifest_log: INSERT and SELECT round-trip with null outcome', () => {
    const conn = migratedDb();
    const now = Date.now();
    const nodeIds = ['n1', 'n2', 'n3'];
    insertManifest(conn, 'm1', nodeIds, 250, null);

    const row = conn
      .prepare('SELECT * FROM manifest_log WHERE id = ?')
      .get('m1') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row['node_ids']).toBe(JSON.stringify(nodeIds));
    expect(JSON.parse(row['node_ids'] as string)).toEqual(nodeIds);
    expect(row['token_count']).toBe(250);
    expect(row['outcome']).toBeNull();
    expect(typeof row['created_at']).toBe('number');
    expect(row['created_at']).toBeGreaterThanOrEqual(now);
  });

  it('manifest_log: UPDATE outcome from NULL to WORKED', () => {
    const conn = migratedDb();
    insertManifest(conn, 'm1', ['n1'], 100, null);

    conn.prepare(`UPDATE manifest_log SET outcome = 'WORKED' WHERE id = ?`).run('m1');

    const row = conn
      .prepare('SELECT outcome FROM manifest_log WHERE id = ?')
      .get('m1') as Record<string, unknown>;
    expect(row['outcome']).toBe('WORKED');
  });

  it('manifest_log: UPDATE outcome from NULL to FAILED', () => {
    const conn = migratedDb();
    insertManifest(conn, 'm1', ['n1'], 100, null);

    conn.prepare(`UPDATE manifest_log SET outcome = 'FAILED' WHERE id = ?`).run('m1');

    const row = conn
      .prepare('SELECT outcome FROM manifest_log WHERE id = ?')
      .get('m1') as Record<string, unknown>;
    expect(row['outcome']).toBe('FAILED');
  });

  it('manifest_log: UPDATE outcome back to NULL', () => {
    const conn = migratedDb();
    insertManifest(conn, 'm1', ['n1'], 100, 'WORKED');

    conn.prepare(`UPDATE manifest_log SET outcome = NULL WHERE id = ?`).run('m1');

    const row = conn
      .prepare('SELECT outcome FROM manifest_log WHERE id = ?')
      .get('m1') as Record<string, unknown>;
    expect(row['outcome']).toBeNull();
  });

  it('manifest_log: UPDATE rejects invalid outcome value', () => {
    const conn = migratedDb();
    insertManifest(conn, 'm1', ['n1'], 100, null);

    expect(() => {
      conn.prepare(`UPDATE manifest_log SET outcome = 'INVALID' WHERE id = ?`).run('m1');
    }).toThrow(/CHECK constraint failed/i);
  });

  it('manifest_log: DELETE removes the row', () => {
    const conn = migratedDb();
    insertManifest(conn, 'm1', ['n1'], 100);

    conn.prepare('DELETE FROM manifest_log WHERE id = ?').run('m1');

    const row = conn.prepare('SELECT * FROM manifest_log WHERE id = ?').get('m1');
    expect(row).toBeUndefined();
  });

  it('manifest_log: node_ids JSON array survives round-trip for large payload', () => {
    const conn = migratedDb();
    const manyIds = Array.from({ length: 50 }, (_, i) => `node-${i}`);
    insertManifest(conn, 'm1', manyIds, 4096);

    const row = conn
      .prepare('SELECT node_ids FROM manifest_log WHERE id = ?')
      .get('m1') as Record<string, unknown>;
    expect(JSON.parse(row['node_ids'] as string)).toEqual(manyIds);
  });

  // ── Cross-table interactions ──────────────────────────────────────────────

  it('three-table session: nodes → edges → manifest all coexist in same migrated DB', () => {
    const conn = migratedDb();

    insertNode(conn, 'n1', { type: 'FILE_STATE', fsm_state: 'DOC_EDIT' });
    insertNode(conn, 'n2', { type: 'TERMINAL_ERROR', fsm_state: 'RUNTIME_ERR' });
    insertEdge(conn, 'e1', 'n1', 'n2', 'CAUSED_BY');
    insertManifest(conn, 'm1', ['n1', 'n2'], 180, 'WORKED');

    const nodeCount = (
      conn.prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as { cnt: number }
    ).cnt;
    const edgeCount = (
      conn.prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as { cnt: number }
    ).cnt;
    const manifestCount = (
      conn.prepare('SELECT COUNT(*) as cnt FROM manifest_log').get() as { cnt: number }
    ).cnt;

    expect(nodeCount).toBe(2);
    expect(edgeCount).toBe(1);
    expect(manifestCount).toBe(1);
  });

  it('three-table session: deleting edge allows node deletion, manifest unaffected', () => {
    const conn = migratedDb();
    insertNode(conn, 'n1');
    insertNode(conn, 'n2');
    insertEdge(conn, 'e1', 'n1', 'n2');
    insertManifest(conn, 'm1', ['n1', 'n2'], 100, 'WORKED');

    // Remove edge first, then delete node — should now succeed.
    conn.prepare('DELETE FROM graph_edges WHERE id = ?').run('e1');
    expect(() => conn.prepare('DELETE FROM graph_nodes WHERE id = ?').run('n1')).not.toThrow();

    // manifest_log has no FK to graph_nodes; it remains intact after node deletion.
    const manifest = conn
      .prepare('SELECT * FROM manifest_log WHERE id = ?')
      .get('m1') as Record<string, unknown>;
    expect(manifest).toBeDefined();
    expect(manifest['outcome']).toBe('WORKED');
  });
});
