import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase } from '../storage/connection.js';
import { runMigrations } from '../storage/migrations.js';
import { resolveLwwConflict } from './lww.js';

/**
 * Phase 3.3 — LWW Conflict Resolution Tests
 *
 * SSOT §6.3: a new CONSTRAINT node sharing a constraint_key with an
 * ACTIVE constraint draws a CONTRADICTS edge and flips the old node
 * to SUPERSEDED.
 *
 * Coverage:
 *   1. Second constraint with same key supersedes the first
 *   2. CONTRADICTS edge is correctly recorded
 *   3. A third, unrelated constraint key is unaffected
 *   4. No-op when no existing ACTIVE node shares the key
 *   5. Multiple existing ACTIVE nodes with same key are all superseded
 *   6. Already-SUPERSEDED nodes are not re-processed
 *   7. New node remains ACTIVE after conflict resolution
 */

describe('LWW conflict resolution — Phase 3.3', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function setup(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-lww-test-'));
    db = openDatabase(join(tempDir, 'graph.db'));
    runMigrations(db);
    return db;
  }

  /** Insert a CONSTRAINT node with the given id and constraint_key. */
  function insertConstraint(
    conn: Database.Database,
    id: string,
    constraintKey: string,
    status: string = 'ACTIVE',
  ): void {
    conn
      .prepare(
        `INSERT INTO graph_nodes
           (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
         VALUES (?, ?, 'CONSTRAINT', ?, 'IDE_IDLE', ?, ?, NULL, ?)`,
      )
      .run(id, 1, `constraint: ${constraintKey}`, constraintKey, status, Date.now());
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

  // ── The exact three-node scenario from the WORKPLAN ────────────────────────

  it('second constraint with same key correctly supersedes the first', () => {
    const conn = setup();

    // Node A: first CONSTRAINT with key "db-choice"
    insertConstraint(conn, 'nodeA', 'db-choice');

    // Node B: second CONSTRAINT with same key "db-choice"
    insertConstraint(conn, 'nodeB', 'db-choice');
    const result = resolveLwwConflict(conn, 'nodeB', 'db-choice');

    // Node A should now be SUPERSEDED.
    const nodeA = conn
      .prepare('SELECT status FROM graph_nodes WHERE id = ?')
      .get('nodeA') as { status: string };
    expect(nodeA.status).toBe('SUPERSEDED');

    // Node B should still be ACTIVE.
    const nodeB = conn
      .prepare('SELECT status FROM graph_nodes WHERE id = ?')
      .get('nodeB') as { status: string };
    expect(nodeB.status).toBe('ACTIVE');

    expect(result.supersededCount).toBe(1);
  });

  it('CONTRADICTS edge is correctly recorded', () => {
    const conn = setup();

    insertConstraint(conn, 'nodeA', 'db-choice');
    insertConstraint(conn, 'nodeB', 'db-choice');
    const result = resolveLwwConflict(conn, 'nodeB', 'db-choice');

    expect(result.edgeIds).toHaveLength(1);

    const edge = conn
      .prepare('SELECT * FROM graph_edges WHERE id = ?')
      .get(result.edgeIds[0]) as Record<string, unknown>;

    expect(edge).toBeDefined();
    expect(edge['from_node_id']).toBe('nodeB'); // new → old
    expect(edge['to_node_id']).toBe('nodeA');
    expect(edge['edge_type']).toBe('CONTRADICTS');
  });

  it('a third unrelated constraint key is unaffected', () => {
    const conn = setup();

    // Nodes A and B share key "db-choice"
    insertConstraint(conn, 'nodeA', 'db-choice');
    insertConstraint(conn, 'nodeB', 'db-choice');
    resolveLwwConflict(conn, 'nodeB', 'db-choice');

    // Node C has a completely different key
    insertConstraint(conn, 'nodeC', 'cache-strategy');
    const result = resolveLwwConflict(conn, 'nodeC', 'cache-strategy');

    // No conflicts — nodeC's key is unique.
    expect(result.supersededCount).toBe(0);
    expect(result.edgeIds).toHaveLength(0);

    // nodeC is still ACTIVE.
    const nodeC = conn
      .prepare('SELECT status FROM graph_nodes WHERE id = ?')
      .get('nodeC') as { status: string };
    expect(nodeC.status).toBe('ACTIVE');

    // nodeB is still ACTIVE (it was the LWW winner for "db-choice").
    const nodeB = conn
      .prepare('SELECT status FROM graph_nodes WHERE id = ?')
      .get('nodeB') as { status: string };
    expect(nodeB.status).toBe('ACTIVE');
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('no-op when no existing ACTIVE node shares the constraint key', () => {
    const conn = setup();

    // First CONSTRAINT with this key — no prior nodes to conflict with.
    insertConstraint(conn, 'nodeA', 'brand-new-key');
    const result = resolveLwwConflict(conn, 'nodeA', 'brand-new-key');

    expect(result.supersededCount).toBe(0);
    expect(result.edgeIds).toHaveLength(0);

    // No edges created.
    const edgeCount = (
      conn.prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as { cnt: number }
    ).cnt;
    expect(edgeCount).toBe(0);
  });

  it('multiple existing ACTIVE nodes with same key are all superseded', () => {
    const conn = setup();

    // Simulate a bug or manual edit: three ACTIVE nodes share a key.
    insertConstraint(conn, 'nodeA', 'db-choice');
    insertConstraint(conn, 'nodeB', 'db-choice');
    insertConstraint(conn, 'nodeC', 'db-choice');

    // nodeD arrives as the new winner.
    insertConstraint(conn, 'nodeD', 'db-choice');
    const result = resolveLwwConflict(conn, 'nodeD', 'db-choice');

    // All three prior nodes superseded.
    expect(result.supersededCount).toBe(3);
    expect(result.edgeIds).toHaveLength(3);

    for (const id of ['nodeA', 'nodeB', 'nodeC']) {
      const row = conn
        .prepare('SELECT status FROM graph_nodes WHERE id = ?')
        .get(id) as { status: string };
      expect(row.status, `${id} should be SUPERSEDED`).toBe('SUPERSEDED');
    }

    // nodeD remains ACTIVE.
    const nodeD = conn
      .prepare('SELECT status FROM graph_nodes WHERE id = ?')
      .get('nodeD') as { status: string };
    expect(nodeD.status).toBe('ACTIVE');
  });

  it('already-SUPERSEDED nodes are not re-processed', () => {
    const conn = setup();

    // nodeA is already SUPERSEDED (e.g. from a prior LWW resolution).
    insertConstraint(conn, 'nodeA', 'db-choice', 'SUPERSEDED');

    // nodeB arrives — nodeA should not generate a new edge since it's
    // already SUPERSEDED (query filters on status = 'ACTIVE' only).
    insertConstraint(conn, 'nodeB', 'db-choice');
    const result = resolveLwwConflict(conn, 'nodeB', 'db-choice');

    expect(result.supersededCount).toBe(0);
    expect(result.edgeIds).toHaveLength(0);

    // No edges created at all.
    const edgeCount = (
      conn.prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as { cnt: number }
    ).cnt;
    expect(edgeCount).toBe(0);
  });

  it('new node remains ACTIVE after conflict resolution', () => {
    const conn = setup();

    insertConstraint(conn, 'nodeA', 'db-choice');
    insertConstraint(conn, 'nodeB', 'db-choice');
    resolveLwwConflict(conn, 'nodeB', 'db-choice');

    // Explicitly verify the new node was not accidentally superseded.
    const nodeB = conn
      .prepare('SELECT status, type, constraint_key FROM graph_nodes WHERE id = ?')
      .get('nodeB') as { status: string; type: string; constraint_key: string };
    expect(nodeB.status).toBe('ACTIVE');
    expect(nodeB.type).toBe('CONSTRAINT');
    expect(nodeB.constraint_key).toBe('db-choice');
  });
});
