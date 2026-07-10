import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { anchorConstraint, parseAnchorText } from './anchor.js';

/**
 * Phase 10.6 — `anchorConstraint()` / `parseAnchorText()` Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] `stenod anchor "<text>"` correctly creates a `CONSTRAINT` node
 *
 * These test the underlying insert function directly (fixture DB); CLI
 * wiring itself is covered separately in `cli/anchor-cli.test.ts`, mirroring
 * the split already used for Phase 9.x (pure logic) vs Phase 10.x (CLI
 * invocation) elsewhere in this test suite.
 */
describe('cli/anchor — parseAnchorText', () => {
  it('splits "key=value" into a key and the remaining content', () => {
    expect(parseAnchorText('lang-strictness=always use TypeScript strict mode')).toEqual({
      key: 'lang-strictness',
      content: 'always use TypeScript strict mode',
    });
  });

  it('returns no key for plain text with no "="', () => {
    expect(parseAnchorText('always use TypeScript strict mode')).toEqual({
      key: undefined,
      content: 'always use TypeScript strict mode',
    });
  });

  it('does not treat a key containing whitespace before "=" as a key', () => {
    const text = 'always use strict mode = required';
    expect(parseAnchorText(text)).toEqual({ key: undefined, content: text });
  });

  it('splits only on the first "=", keeping later "=" characters in the value', () => {
    expect(parseAnchorText('flag=a=b=c')).toEqual({ key: 'flag', content: 'a=b=c' });
  });
});

describe('cli/anchor — anchorConstraint', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function freshDb(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-anchor-test-'));
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

  it('creates an ACTIVE CONSTRAINT node with the parsed key and content', () => {
    const conn = freshDb();

    const result = anchorConstraint(conn, 'lang-strictness=always use TypeScript strict mode', 5_000);

    expect(result.created).toBe(true);
    expect(result.constraintKey).toBe('lang-strictness');

    const row = conn.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(result.id) as Record<
      string,
      unknown
    >;
    expect(row['type']).toBe('CONSTRAINT');
    expect(row['status']).toBe('ACTIVE');
    expect(row['constraint_key']).toBe('lang-strictness');
    expect(row['content']).toBe('always use TypeScript strict mode');
    expect(row['created_at']).toBe(5_000);
    expect(row['source_file']).toBeNull();
  });

  it('creates a CONSTRAINT node with a NULL constraint_key when text has no "key="', () => {
    const conn = freshDb();

    const result = anchorConstraint(conn, 'always use TypeScript strict mode', 5_000);

    expect(result.constraintKey).toBeUndefined();
    const row = conn.prepare('SELECT constraint_key FROM graph_nodes WHERE id = ?').get(result.id) as {
      constraint_key: string | null;
    };
    expect(row.constraint_key).toBeNull();
    expect(result.lww).toBeUndefined();
  });

  it('a second anchor sharing the same key supersedes the first via LWW', () => {
    const conn = freshDb();

    const first = anchorConstraint(conn, 'lang-strictness=always use TypeScript strict mode', 1_000);
    const second = anchorConstraint(conn, 'lang-strictness=actually, allow implicit any', 2_000);

    expect(second.lww?.supersededCount).toBe(1);

    const firstRow = conn.prepare('SELECT status FROM graph_nodes WHERE id = ?').get(first.id) as {
      status: string;
    };
    const secondRow = conn.prepare('SELECT status FROM graph_nodes WHERE id = ?').get(second.id) as {
      status: string;
    };
    expect(firstRow.status).toBe('SUPERSEDED');
    expect(secondRow.status).toBe('ACTIVE');

    const edge = conn
      .prepare('SELECT * FROM graph_edges WHERE from_node_id = ? AND to_node_id = ?')
      .get(second.id, first.id) as Record<string, unknown> | undefined;
    expect(edge?.['edge_type']).toBe('CONTRADICTS');
  });

  it('anchoring two different keys does not trigger LWW between them', () => {
    const conn = freshDb();

    anchorConstraint(conn, 'a=first constraint', 1_000);
    const second = anchorConstraint(conn, 'b=second constraint', 2_000);

    expect(second.lww?.supersededCount).toBe(0);
    const rows = conn.prepare("SELECT status FROM graph_nodes WHERE type = 'CONSTRAINT'").all() as Array<{
      status: string;
    }>;
    expect(rows.every((r) => r.status === 'ACTIVE')).toBe(true);
  });

  it('re-anchoring byte-identical text is a safe no-op (same content hash)', () => {
    const conn = freshDb();

    const first = anchorConstraint(conn, 'k=identical text', 1_000);
    const second = anchorConstraint(conn, 'k=identical text', 2_000);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const rows = conn.prepare("SELECT * FROM graph_nodes WHERE type = 'CONSTRAINT'").all();
    expect(rows).toHaveLength(1);
  });

  it('derives fsm_state from the most recent ACTIVE node rather than hardcoding IDE_IDLE', () => {
    const conn = freshDb();
    conn
      .prepare(
        `INSERT INTO graph_nodes
           (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
         VALUES ('e1', 1, 'TERMINAL_ERROR', 'boom', 'RUNTIME_ERR', NULL, 'ACTIVE', NULL, ?)`
      )
      .run(1_000);

    const result = anchorConstraint(conn, 'k=fix the boom', 2_000);

    const row = conn.prepare('SELECT fsm_state FROM graph_nodes WHERE id = ?').get(result.id) as {
      fsm_state: string;
    };
    expect(row.fsm_state).toBe('RUNTIME_ERR');
  });
});
