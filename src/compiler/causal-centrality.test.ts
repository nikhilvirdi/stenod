import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { calculateCausalCentrality } from './causal-centrality.js';

/**
 * Phase 8.3 — Causal Centrality Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Degree counts match expected values on a small fixture graph
 *
 * Verify line: "unit test against a hand-built fixture graph" — the graph
 * below is built once in beforeEach-equivalent setup() and its expected
 * in/out/total degrees for every node are hand-computed in comments.
 *
 * Fixture graph (5 nodes, 4 edges):
 *   A -> B (CAUSED_BY)
 *   A -> C (DEPENDS_ON)
 *   B -> C (REPLACES)
 *   D -> A (CONTRADICTS)
 *   E: isolated, no edges at all
 *
 * Hand-computed expected degrees:
 *   A: out=2 (A->B, A->C), in=1 (D->A)          -> total=3
 *   B: out=1 (B->C),       in=1 (A->B)          -> total=2
 *   C: out=0,               in=2 (A->C, B->C)    -> total=2
 *   D: out=1 (D->A),        in=0                 -> total=1
 *   E: out=0,               in=0                 -> total=0
 */
describe('compiler/causal-centrality — Phase 8.3', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function insertNode(conn: Database.Database, id: string, eventId: number): void {
    conn
      .prepare(
        `INSERT INTO graph_nodes
           (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
         VALUES (?, ?, 'FILE_STATE', ?, 'IDE_IDLE', NULL, 'ACTIVE', NULL, ?)`
      )
      .run(id, eventId, `content-${id}`, Date.now());
  }

  function insertEdge(
    conn: Database.Database,
    id: string,
    fromNodeId: string,
    toNodeId: string,
    edgeType: string
  ): void {
    conn
      .prepare(
        `INSERT INTO graph_edges (id, from_node_id, to_node_id, edge_type, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, fromNodeId, toNodeId, edgeType, Date.now());
  }

  function buildFixtureGraph(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-centrality-test-'));
    db = openDatabase(join(tempDir, 'graph.db'));
    runMigrations(db);

    for (const [i, id] of ['A', 'B', 'C', 'D', 'E'].entries()) {
      insertNode(db, id, i + 1);
    }

    insertEdge(db, 'e1', 'A', 'B', 'CAUSED_BY');
    insertEdge(db, 'e2', 'A', 'C', 'DEPENDS_ON');
    insertEdge(db, 'e3', 'B', 'C', 'REPLACES');
    insertEdge(db, 'e4', 'D', 'A', 'CONTRADICTS');
    // E has no edges — isolated node.

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

  it('node A: out=2, in=1, total=3', () => {
    const conn = buildFixtureGraph();
    expect(calculateCausalCentrality(conn, 'A')).toEqual({
      inDegree: 1,
      outDegree: 2,
      total: 3,
    });
  });

  it('node B: out=1, in=1, total=2', () => {
    const conn = buildFixtureGraph();
    expect(calculateCausalCentrality(conn, 'B')).toEqual({
      inDegree: 1,
      outDegree: 1,
      total: 2,
    });
  });

  it('node C: out=0, in=2, total=2', () => {
    const conn = buildFixtureGraph();
    expect(calculateCausalCentrality(conn, 'C')).toEqual({
      inDegree: 2,
      outDegree: 0,
      total: 2,
    });
  });

  it('node D: out=1, in=0, total=1', () => {
    const conn = buildFixtureGraph();
    expect(calculateCausalCentrality(conn, 'D')).toEqual({
      inDegree: 0,
      outDegree: 1,
      total: 1,
    });
  });

  it('node E (isolated, no edges): out=0, in=0, total=0', () => {
    const conn = buildFixtureGraph();
    expect(calculateCausalCentrality(conn, 'E')).toEqual({
      inDegree: 0,
      outDegree: 0,
      total: 0,
    });
  });

  it('a nodeId not present in graph_edges at all (and not even in graph_nodes) still returns zero degrees, not an error', () => {
    const conn = buildFixtureGraph();
    expect(calculateCausalCentrality(conn, 'nonexistent-node-id')).toEqual({
      inDegree: 0,
      outDegree: 0,
      total: 0,
    });
  });
});
