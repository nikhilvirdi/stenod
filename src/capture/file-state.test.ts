/**
 * Phase 4.4 — FILE_STATE Node Creation Tests
 *
 * SSOT §6.2, §6.3 / WORKPLAN Phase 4.4 "Done when" checklist:
 *   [x] A file save produces exactly one correctly-typed node with correct
 *       fsm_state
 *
 * Two layers, matching the phase's Verify line ("end-to-end test: save a
 * fixture file, confirm the resulting DB row"):
 *   1. Unit tests calling writeFileStateNode() directly against a migrated
 *      in-memory-equivalent temp DB — covers FSM-driven fsm_state (not
 *      hardcoded), id/event_id/status/type correctness, and the
 *      duplicate-content id-collision behavior.
 *   2. An end-to-end test using the real Phase 4.1 watcher via
 *      createFileStateCapture(): a real file save on disk produces a real
 *      graph_nodes row.
 *
 * Also covers Phase 4.5's wiring of redactSecrets() into this same write
 * path (see the dedicated redaction.test.ts for the redaction patterns
 * themselves — this file only checks that the write path actually calls it).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { openDatabase, runMigrations } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { writeFileStateNode, createFileStateCapture } from './file-state.js';

/** How long to wait (ms) for an async DB write to land before giving up. */
const EVENT_TIMEOUT_MS = 3000;

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 25);
  });
}

describe('capture/file-state — Phase 4.4', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function migratedDb(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-file-state-test-'));
    db = openDatabase(join(tempDir, 'graph.db'));
    runMigrations(db);
    return db;
  }

  afterEach(() => {
    if (db) {
      db.close();
      db = undefined;
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── writeFileStateNode: unit level ──────────────────────────────────────

  it('writes a FILE_STATE node with correct type/status/id/source_file', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm('IDE_IDLE');
    const before = Date.now();

    const result = writeFileStateNode(conn, fsm, '/project/src/index.ts', 'const x = 1;');

    const row = conn
      .prepare('SELECT * FROM graph_nodes WHERE id = ?')
      .get(result.id) as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row['type']).toBe('FILE_STATE');
    expect(row['status']).toBe('ACTIVE');
    expect(row['source_file']).toBe('/project/src/index.ts');
    expect(row['content']).toBe('const x = 1;');
    expect(row['constraint_key']).toBeNull();
    expect(row['id']).toBe(createHash('sha256').update('const x = 1;').digest('hex'));
    expect(row['created_at']).toBeGreaterThanOrEqual(before);
  });

  it('a save from IDE_IDLE stays IDE_IDLE (fsm_state is FSM-driven, not hardcoded to DOC_EDIT)', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm('IDE_IDLE');

    const result = writeFileStateNode(conn, fsm, '/f.ts', 'a');

    expect(result.fsmState).toBe('IDE_IDLE');
    const row = conn.prepare('SELECT fsm_state FROM graph_nodes WHERE id = ?').get(result.id) as {
      fsm_state: string;
    };
    expect(row.fsm_state).toBe('IDE_IDLE');
  });

  it('a save from RUNTIME_ERR transitions to DOC_EDIT (the headline case from the Build line)', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm('RUNTIME_ERR');

    const result = writeFileStateNode(conn, fsm, '/f.ts', 'a');

    expect(result.fsmState).toBe('DOC_EDIT');
    const row = conn.prepare('SELECT fsm_state FROM graph_nodes WHERE id = ?').get(result.id) as {
      fsm_state: string;
    };
    expect(row.fsm_state).toBe('DOC_EDIT');
  });

  it('event_id is monotonically increasing across successive writes', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm();

    const r1 = writeFileStateNode(conn, fsm, '/a.ts', 'aaa');
    const r2 = writeFileStateNode(conn, fsm, '/b.ts', 'bbb');
    const r3 = writeFileStateNode(conn, fsm, '/c.ts', 'ccc');

    expect(r2.eventId).toBeGreaterThan(r1.eventId);
    expect(r3.eventId).toBeGreaterThan(r2.eventId);
  });

  it('re-saving identical content is a no-op write (id collision), does not throw, does not duplicate the row', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm();

    const first = writeFileStateNode(conn, fsm, '/a.ts', 'same content');
    expect(first.created).toBe(true);

    const second = writeFileStateNode(conn, fsm, '/a.ts', 'same content');
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const count = (
      conn.prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as { cnt: number }
    ).cnt;
    expect(count).toBe(1);
  });

  it('re-saving identical content does not resurrect a REJECTED node', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm();

    const first = writeFileStateNode(conn, fsm, '/a.ts', 'same content');
    conn.prepare(`UPDATE graph_nodes SET status = 'REJECTED' WHERE id = ?`).run(first.id);

    writeFileStateNode(conn, fsm, '/a.ts', 'same content');

    const row = conn.prepare('SELECT status FROM graph_nodes WHERE id = ?').get(first.id) as {
      status: string;
    };
    expect(row.status).toBe('REJECTED');
  });

  it('the FSM still advances even when the write is a no-op duplicate', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm('RUNTIME_ERR');

    writeFileStateNode(conn, fsm, '/a.ts', 'same content');
    expect(fsm.state).toBe('DOC_EDIT');

    // Second save of identical content: row write is a no-op, but the SAVE
    // event still fires against the FSM (DOC_EDIT + SAVE -> DOC_EDIT, a
    // same-state no-op per the Phase 3.1 transition table — assert via a
    // state that would visibly change instead, by forcing an ERROR first).
    fsm.apply('ERROR');
    expect(fsm.state).toBe('RUNTIME_ERR');
    writeFileStateNode(conn, fsm, '/a.ts', 'same content');
    expect(fsm.state).toBe('DOC_EDIT');
  });

  // ── Phase 4.5: secret redaction wiring ──────────────────────────────────

  it('redacts secret-shaped content before it reaches graph_nodes.content', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm();
    const raw = 'const apiKey = "AKIAABCDEFGHIJKLMNOP";\nfunction ok() { return 1; }';

    const result = writeFileStateNode(conn, fsm, '/secrets.ts', raw);

    const row = conn.prepare('SELECT content FROM graph_nodes WHERE id = ?').get(result.id) as {
      content: string;
    };
    expect(row.content).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(row.content).toContain('[REDACTED]');
    expect(row.content).toContain('function ok() { return 1; }');

    // id is SHA-256 of the *redacted* content (SSOT §6.2), not the raw bytes.
    expect(result.id).toBe(createHash('sha256').update(row.content).digest('hex'));
  });

  // ── End-to-end: real watcher + real DB ──────────────────────────────────

  it('a real file save through createFileStateCapture produces a matching graph_nodes row', async () => {
    const conn = migratedDb();
    const fsm = new SessionFsm('IDE_IDLE');
    const projectRoot = tempDir;

    let watcher: FSWatcher | undefined;
    try {
      watcher = createFileStateCapture(conn, fsm, projectRoot);
      await new Promise<void>((resolve) => watcher!.once('ready', resolve));

      const srcFile = join(projectRoot, 'src', 'index.ts');
      const content = 'export const answer = 42;';
      mkdirSync(join(srcFile, '..'), { recursive: true });
      writeFileSync(srcFile, content, 'utf8');

      const expectedId = createHash('sha256').update(content).digest('hex');
      const found = await waitFor(() => {
        const row = conn.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(expectedId);
        return row !== undefined;
      }, EVENT_TIMEOUT_MS);

      expect(found, 'expected a graph_nodes row for the saved file').toBe(true);

      const row = conn
        .prepare('SELECT * FROM graph_nodes WHERE id = ?')
        .get(expectedId) as Record<string, unknown>;
      expect(row['type']).toBe('FILE_STATE');
      expect(row['status']).toBe('ACTIVE');
      expect(row['content']).toBe(content);
      expect(row['source_file']).toBe(srcFile);
      expect(row['fsm_state']).toBe('IDE_IDLE');
    } finally {
      await watcher?.close();
    }
  });
});
