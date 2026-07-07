import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from '../connection.js';
import { createGraphNodesTable } from './graph-nodes.js';
import { createGraphEdgesTable } from './graph-edges.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Phase 1.3 verification tests — graph_edges table.
 *
 * Done when:
 *   [x] Table creates cleanly, FK constraints active
 *   [x] Insert fails on a from_node_id/to_node_id that doesn't exist in graph_nodes
 *
 * Verify: FK-violation test + valid insert/select test.
 */

describe('storage/schema/graph-edges — Phase 1.3', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function setup(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-test-'));
    const dbPath = join(tempDir, 'graph.db');
    db = openDatabase(dbPath);
    // graph_edges has a FK to graph_nodes, so graph_nodes must exist first.
    createGraphNodesTable(db);
    createGraphEdgesTable(db);
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
    const columns = conn.pragma('table_info(graph_edges)') as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toEqual(['id', 'from_node_id', 'to_node_id', 'edge_type', 'created_at']);
  });

  // ── FK enforcement tests ──────────────────────────────────────────────────

  it('FK constraint is active — insert fails when from_node_id does not exist in graph_nodes', () => {
    const conn = setup();
    expect(() => {
      conn
        .prepare(
          `INSERT INTO graph_edges (id, from_node_id, to_node_id, edge_type, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('edge-1', 'nonexistent-node', 'also-nonexistent', 'REPLACES', Date.now());
    }).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('FK constraint is active — insert fails when to_node_id does not exist in graph_nodes', () => {
    const conn = setup();
    // Insert a valid from_node first.
    conn
      .prepare(
        `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('node-1', 1, 'FILE_STATE', 'content', 'IDE_IDLE', 'ACTIVE', Date.now());

    expect(() => {
      conn
        .prepare(
          `INSERT INTO graph_edges (id, from_node_id, to_node_id, edge_type, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('edge-1', 'node-1', 'nonexistent-to', 'CAUSED_BY', Date.now());
    }).toThrow(/FOREIGN KEY constraint failed/i);
  });

  // ── Valid insert / select ─────────────────────────────────────────────────

  it('valid insert and select round-trip succeeds', () => {
    const conn = setup();
    const now = Date.now();

    // Insert two valid nodes into graph_nodes first.
    const insertNode = conn.prepare(
      `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insertNode.run('node-a', 1, 'FILE_STATE', 'content-a', 'DOC_EDIT', 'ACTIVE', now);
    insertNode.run('node-b', 2, 'TERMINAL_ERROR', 'content-b', 'RUNTIME_ERR', 'ACTIVE', now);

    // Insert a valid edge.
    conn
      .prepare(
        `INSERT INTO graph_edges (id, from_node_id, to_node_id, edge_type, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('edge-1', 'node-a', 'node-b', 'CAUSED_BY', now);

    const row = conn
      .prepare('SELECT * FROM graph_edges WHERE id = ?')
      .get('edge-1') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row['id']).toBe('edge-1');
    expect(row['from_node_id']).toBe('node-a');
    expect(row['to_node_id']).toBe('node-b');
    expect(row['edge_type']).toBe('CAUSED_BY');
    expect(row['created_at']).toBe(now);
  });

  // ── Edge type CHECK constraint ────────────────────────────────────────────

  it('rejects an invalid edge_type value', () => {
    const conn = setup();
    const now = Date.now();

    const insertNode = conn.prepare(
      `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insertNode.run('node-a', 1, 'FILE_STATE', 'content-a', 'DOC_EDIT', 'ACTIVE', now);
    insertNode.run('node-b', 2, 'FILE_STATE', 'content-b', 'DOC_EDIT', 'ACTIVE', now);

    expect(() => {
      conn
        .prepare(
          `INSERT INTO graph_edges (id, from_node_id, to_node_id, edge_type, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('edge-bad', 'node-a', 'node-b', 'INVALID_TYPE', now);
    }).toThrow(/CHECK constraint failed/i);
  });

  // ── All valid edge_type values are accepted ───────────────────────────────

  it('accepts all four valid edge_type values', () => {
    const conn = setup();
    const now = Date.now();

    const insertNode = conn.prepare(
      `INSERT INTO graph_nodes (id, event_id, type, content, fsm_state, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insertNode.run('n1', 1, 'FILE_STATE', 'c', 'IDE_IDLE', 'ACTIVE', now);
    insertNode.run('n2', 2, 'FILE_STATE', 'c', 'IDE_IDLE', 'ACTIVE', now);

    const insertEdge = conn.prepare(
      `INSERT INTO graph_edges (id, from_node_id, to_node_id, edge_type, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );

    expect(() => insertEdge.run('e1', 'n1', 'n2', 'REPLACES', now)).not.toThrow();
    expect(() => insertEdge.run('e2', 'n1', 'n2', 'CAUSED_BY', now)).not.toThrow();
    expect(() => insertEdge.run('e3', 'n1', 'n2', 'CONTRADICTS', now)).not.toThrow();
    expect(() => insertEdge.run('e4', 'n1', 'n2', 'DEPENDS_ON', now)).not.toThrow();
  });
});
