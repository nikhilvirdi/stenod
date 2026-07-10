import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { compileManifest } from './db-to-manifest.js';
import type { CompileManifestParams } from './db-to-manifest.js';

/**
 * Phase 8.9 — DB-to-Manifest Orchestrator Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Running this function twice against an identical DB state produces
 *       byte-identical manifest output — genuine end-to-end determinism
 *   [x] The query includes an explicit ORDER BY
 *   [x] CONSTRAINT nodes are force-included via real DB-fetched rows, not
 *       mocked objects
 *
 * Verify line: "integration test using a real (temp-file or in-memory)
 * SQLite DB, seeded with a realistic mix of node types/statuses/edges, run
 * twice, diff output byte-for-byte."
 */
describe('compiler/db-to-manifest — Phase 8.9', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  const NOW = 1_800_000_000_000; // fixed reference "now" — same convention as Phase 3.4's rejectSince(nowMs)

  function insertNode(
    conn: Database.Database,
    opts: {
      id: string;
      eventId: number;
      type: string;
      content: string;
      status?: string;
      constraintKey?: string | null;
      createdAt?: number;
    }
  ): void {
    conn
      .prepare(
        `INSERT INTO graph_nodes
           (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
         VALUES (?, ?, ?, ?, 'IDE_IDLE', ?, ?, NULL, ?)`
      )
      .run(
        opts.id,
        opts.eventId,
        opts.type,
        opts.content,
        opts.constraintKey ?? null,
        opts.status ?? 'ACTIVE',
        opts.createdAt ?? NOW
      );
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
      .run(id, fromNodeId, toNodeId, edgeType, NOW);
  }

  function freshDb(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-db-to-manifest-test-'));
    db = openDatabase(join(tempDir, 'graph.db'));
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

  it('running compileManifest twice against an identical, realistic DB state produces byte-identical output', () => {
    const conn = freshDb();

    insertNode(conn, {
      id: 'C1',
      eventId: 1,
      type: 'CONSTRAINT',
      content: 'always use TypeScript strict mode',
      constraintKey: 'lang-strictness',
      createdAt: NOW - 60_000,
    });
    insertNode(conn, {
      id: 'A',
      eventId: 2,
      type: 'FILE_STATE',
      content: 'export function add(a: number, b: number): number { return a + b; }',
      createdAt: NOW - 30_000,
    });
    insertNode(conn, {
      id: 'B',
      eventId: 3,
      type: 'TERMINAL_SUCCESS',
      content: 'npm test passed',
      createdAt: NOW - 10_000,
    });
    insertNode(conn, {
      id: 'REJ',
      eventId: 4,
      type: 'FILE_STATE',
      content: 'an old rejected file state, should never appear',
      status: 'REJECTED',
      createdAt: NOW - 5_000,
    });
    insertNode(conn, {
      id: 'SUP',
      eventId: 5,
      type: 'CONSTRAINT',
      content: 'stale superseded constraint, should never appear',
      status: 'SUPERSEDED',
      constraintKey: 'lang-strictness',
      createdAt: NOW - 90_000,
    });

    insertEdge(conn, 'e1', 'A', 'B', 'CAUSED_BY');
    insertEdge(conn, 'e2', 'C1', 'A', 'DEPENDS_ON');

    const params: CompileManifestParams = {
      resumeInstruction: 'pick up where you left off',
      fsmState: 'RUNTIME_ERR',
      unresolvedErrorContext: 'build failed with exit code 1',
      nowMs: NOW,
    };

    const first = compileManifest(conn, 1000, params);
    const second = compileManifest(conn, 1000, params);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // Sanity checks on the composed, real-DB-backed result (not just that it's stable).
    const allIncludedIds = [...first.primacyZone, ...first.middleZone].map((n) => n.id);
    expect(allIncludedIds).not.toContain('REJ');
    expect(allIncludedIds).not.toContain('SUP');
    expect(first.primacyZone.map((n) => n.id)).toEqual(['C1']);
    expect(first.recencyZone.nextActions).toBeDefined();
    expect(first.recencyZone.nextActions?.message).toContain('build failed with exit code 1');
  });

  it('fetches nodes in explicit event_id order, not id or insertion/rowid order', () => {
    const conn = freshDb();

    // Physically inserted M, Z, A (rowid order); lexical id order would be A, M, Z;
    // only an explicit `ORDER BY event_id ASC` yields Z(1), A(2), M(3).
    insertNode(conn, { id: 'M', eventId: 3, type: 'FILE_STATE', content: 'identical content' });
    insertNode(conn, { id: 'Z', eventId: 1, type: 'FILE_STATE', content: 'identical content' });
    insertNode(conn, { id: 'A', eventId: 2, type: 'FILE_STATE', content: 'identical content' });

    const manifest = compileManifest(conn, 1000, {
      resumeInstruction: 'resume',
      fsmState: 'IDE_IDLE',
      nowMs: NOW,
    });

    // Identical content, timestamp, and (no) edges -> identical utility/token ratio for all
    // three, so the greedy sort's stable tie-break preserves fetch order exactly.
    expect(manifest.middleZone.map((n) => n.id)).toEqual(['Z', 'A', 'M']);
  });

  it('a CONSTRAINT node fetched from a real DB row is force-included even when the token budget is otherwise exhausted', () => {
    const conn = freshDb();

    insertNode(conn, {
      id: 'C-force',
      eventId: 1,
      type: 'CONSTRAINT',
      content: 'must never use var, only const/let',
      createdAt: NOW - 1_000_000, // old -> low decay, would rank terribly on its own
    });
    insertNode(conn, {
      id: 'F1',
      eventId: 2,
      type: 'FILE_STATE',
      content: 'let x = 1;',
      createdAt: NOW,
    });

    const manifest = compileManifest(conn, 0, {
      resumeInstruction: 'resume',
      fsmState: 'IDE_IDLE',
      nowMs: NOW,
    });

    expect(manifest.primacyZone.map((n) => n.id)).toEqual(['C-force']);
    expect(manifest.middleZone).toEqual([]);
  });
});
