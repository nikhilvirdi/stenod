import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { compileManifest } from './db-to-manifest.js';
import type { CompileManifestParams } from './db-to-manifest.js';
import { countTokens } from './tokenizer.js';

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
      sourceFile?: string | null;
      createdAt?: number;
    }
  ): void {
    conn
      .prepare(
        `INSERT INTO graph_nodes
           (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
         VALUES (?, ?, ?, ?, 'IDE_IDLE', ?, ?, ?, ?)`
      )
      .run(
        opts.id,
        opts.eventId,
        opts.type,
        opts.content,
        opts.constraintKey ?? null,
        opts.status ?? 'ACTIVE',
        opts.sourceFile ?? null,
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

  describe('Phase 8.10 — Tiered Content Inclusion Fix', () => {
    /** Deterministic content guaranteed to tokenize to well over 300 tokens. */
    function longContent(): string {
      return Array.from({ length: 500 }, (_, i) => `line ${i}: const value${i} = ${i};`).join('\n');
    }

    it('CONSTRAINT nodes carry full, uncapped content regardless of length', () => {
      const conn = freshDb();
      const content = longContent();
      expect(countTokens(content)).toBeGreaterThan(300);

      insertNode(conn, { id: 'C-long', eventId: 1, type: 'CONSTRAINT', content, createdAt: NOW });

      const manifest = compileManifest(conn, 100_000, {
        resumeInstruction: 'resume',
        fsmState: 'IDE_IDLE',
        nowMs: NOW,
      });

      const node = manifest.primacyZone.find((n) => n.id === 'C-long');
      expect(node!.contentPreview).toBe(content);
      expect(node!.tokenCost).toBe(countTokens(content));
    });

    it('a node with utilityScore >= 0.6 carries a bounded excerpt, capped at 300 tokens', () => {
      const conn = freshDb();
      const content = longContent();
      expect(countTokens(content)).toBeGreaterThan(300);

      insertNode(conn, { id: 'HIGH', eventId: 1, type: 'FILE_STATE', content, createdAt: NOW });
      insertNode(conn, { id: 'OTHER', eventId: 2, type: 'FILE_STATE', content: 'unrelated', createdAt: NOW });
      // One edge -> causal_centrality=1 -> with decay(0)=1 (fresh node, nowMs
      // matches createdAt) utilityScore = 0.4*1 + 0.4*1 + 0.2*0 = 0.8 >= 0.6,
      // genuinely qualifying this node for tier 2, not asserted by fiat.
      insertEdge(conn, 'e-centrality', 'HIGH', 'OTHER', 'CAUSED_BY');

      const manifest = compileManifest(conn, 100_000, {
        resumeInstruction: 'resume',
        fsmState: 'IDE_IDLE',
        nowMs: NOW,
      });

      const node = [...manifest.primacyZone, ...manifest.middleZone].find((n) => n.id === 'HIGH');
      expect(node!.utilityScore).toBeGreaterThanOrEqual(0.6);
      expect(node!.contentPreview).not.toBe(content); // truncated, not full
      expect(content.startsWith(node!.contentPreview)).toBe(true); // a genuine prefix excerpt
      expect(countTokens(node!.contentPreview)).toBeLessThanOrEqual(300);
      expect(node!.tokenCost).toBe(countTokens(node!.contentPreview));
    });

    it('a utilityScore >= 0.6 node whose content is already under 300 tokens is included in full, unmodified', () => {
      const conn = freshDb();
      const content = 'export const x = 1;';

      insertNode(conn, { id: 'SHORT-HIGH', eventId: 1, type: 'FILE_STATE', content, createdAt: NOW });
      insertNode(conn, { id: 'OTHER', eventId: 2, type: 'FILE_STATE', content: 'unrelated', createdAt: NOW });
      insertEdge(conn, 'e-centrality', 'SHORT-HIGH', 'OTHER', 'CAUSED_BY');

      const manifest = compileManifest(conn, 100_000, {
        resumeInstruction: 'resume',
        fsmState: 'IDE_IDLE',
        nowMs: NOW,
      });

      const node = [...manifest.primacyZone, ...manifest.middleZone].find((n) => n.id === 'SHORT-HIGH');
      expect(node!.utilityScore).toBeGreaterThanOrEqual(0.6);
      expect(node!.contentPreview).toBe(content);
      expect(node!.tokenCost).toBe(countTokens(content));
    });

    it('nodes below the 0.6 threshold carry a deterministic one-line template, referencing source_file when present', () => {
      const conn = freshDb();

      insertNode(conn, {
        id: 'LOW-WITH-FILE',
        eventId: 1,
        type: 'FILE_STATE',
        content: 'this raw content must not appear in the manifest',
        sourceFile: 'src/foo.ts',
        createdAt: NOW,
      });
      insertNode(conn, {
        id: 'LOW-NO-FILE',
        eventId: 2,
        type: 'TERMINAL_SUCCESS',
        content: 'this raw content must not appear either',
        createdAt: NOW,
      });

      const manifest = compileManifest(conn, 100_000, {
        resumeInstruction: 'resume',
        fsmState: 'IDE_IDLE',
        nowMs: NOW,
      });

      const withFile = manifest.middleZone.find((n) => n.id === 'LOW-WITH-FILE');
      const noFile = manifest.middleZone.find((n) => n.id === 'LOW-NO-FILE');

      expect(withFile!.utilityScore).toBeLessThan(0.6);
      expect(withFile!.contentPreview).toBe('FILE_STATE in src/foo.ts');
      expect(withFile!.tokenCost).toBe(countTokens('FILE_STATE in src/foo.ts'));

      expect(noFile!.utilityScore).toBeLessThan(0.6);
      expect(noFile!.contentPreview).toBe('TERMINAL_SUCCESS');
      expect(noFile!.tokenCost).toBe(countTokens('TERMINAL_SUCCESS'));

      // Neither node's raw content leaked into the manifest.
      expect(JSON.stringify(manifest)).not.toContain('raw content');
    });

    it('token_cost reflects the emitted contentPreview, not raw content size, across all three tiers', () => {
      const conn = freshDb();
      const longRaw = longContent();

      insertNode(conn, { id: 'C', eventId: 1, type: 'CONSTRAINT', content: longRaw, createdAt: NOW });
      insertNode(conn, { id: 'MID', eventId: 2, type: 'FILE_STATE', content: longRaw, createdAt: NOW });
      insertNode(conn, {
        id: 'LOW',
        eventId: 3,
        type: 'FILE_STATE',
        content: longRaw,
        createdAt: NOW - 1_000_000, // old -> low decay -> tier 3
      });
      insertEdge(conn, 'e1', 'MID', 'C', 'CAUSED_BY'); // gives MID centrality=1 -> tier 2

      const manifest = compileManifest(conn, 100_000, {
        resumeInstruction: 'resume',
        fsmState: 'IDE_IDLE',
        nowMs: NOW,
      });

      const all = [...manifest.primacyZone, ...manifest.middleZone];
      expect(all.map((n) => n.id).sort()).toEqual(['C', 'LOW', 'MID']);
      const rawTokenCost = countTokens(longRaw);

      for (const n of all) {
        expect(n.tokenCost).toBe(countTokens(n.contentPreview));
        if (n.id !== 'C') {
          // Tier 2/3 nodes must cost strictly less than the raw content would.
          expect(n.tokenCost).toBeLessThan(rawTokenCost);
        }
      }
    });
  });
});
