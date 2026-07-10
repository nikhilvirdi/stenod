import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { compileManifest } from '../compiler/index.js';
import { writeManifestLogEntry } from './manifest-log.js';

/**
 * Phase 9.2 — `manifest_log` Write Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Each handoff produces exactly one correct `manifest_log` row
 *
 * Verify line: "test triggering a handoff, inspecting the resulting row."
 *
 * `clipboardy` is mocked in the ordering test below rather than using the
 * real OS clipboard — see Phase 9.1's clipboard.test.ts header comment for
 * why a real clipboard round trip is inherently racy and why exactly one
 * such test exists in the whole suite (clipboard-live.test.ts). This test
 * only needs to know delivery was *attempted*, not that it actually landed
 * on a real clipboard, so the mock is the correct tool here too.
 */
vi.mock('clipboardy', () => ({
  default: {
    write: vi.fn(),
    read: vi.fn(),
  },
}));

describe('delivery/manifest-log — Phase 9.2', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function freshDb(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-manifest-log-test-'));
    db = openDatabase(join(tempDir, 'graph.db'));
    runMigrations(db);
    return db;
  }

  function insertNode(
    conn: Database.Database,
    id: string,
    eventId: number,
    type: string,
    content: string
  ): void {
    conn
      .prepare(
        `INSERT INTO graph_nodes
           (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
         VALUES (?, ?, ?, ?, 'IDE_IDLE', NULL, 'ACTIVE', NULL, ?)`
      )
      .run(id, eventId, type, content, Date.now());
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

  it('a handoff for a real DB-compiled manifest produces exactly one correct manifest_log row', () => {
    const conn = freshDb();
    insertNode(conn, 'C1', 1, 'CONSTRAINT', 'always use TypeScript strict mode');
    insertNode(conn, 'A', 2, 'FILE_STATE', 'export const x = 1;');

    const manifest = compileManifest(conn, 1000, {
      resumeInstruction: 'resume',
      fsmState: 'IDE_IDLE',
    });

    const nowMs = 1_800_000_000_000;
    const entry = writeManifestLogEntry(conn, manifest, nowMs);

    const rows = conn.prepare('SELECT * FROM manifest_log').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row['id']).toBe(entry.id);
    expect(row['created_at']).toBe(nowMs);
    expect(row['outcome']).toBeNull();

    const expectedIds = [...manifest.primacyZone, ...manifest.middleZone].map((n) => n.id);
    expect(JSON.parse(row['node_ids'] as string)).toEqual(expectedIds);
    expect(expectedIds).toEqual(['C1', 'A']);

    const expectedTokenCount = [...manifest.primacyZone, ...manifest.middleZone].reduce(
      (sum, n) => sum + n.tokenCost,
      0
    );
    expect(row['token_count']).toBe(expectedTokenCount);
    expect(entry.tokenCount).toBe(expectedTokenCount);
    expect(entry.outcome).toBeNull();
  });

  it('an empty compiled manifest (no nodes) still writes a valid row', () => {
    const conn = freshDb();

    const manifest = compileManifest(conn, 1000, {
      resumeInstruction: 'nothing to resume',
      fsmState: 'IDE_IDLE',
    });

    const entry = writeManifestLogEntry(conn, manifest);

    const row = conn.prepare('SELECT * FROM manifest_log WHERE id = ?').get(entry.id) as Record<
      string,
      unknown
    >;

    expect(row).toBeDefined();
    expect(JSON.parse(row['node_ids'] as string)).toEqual([]);
    expect(row['token_count']).toBe(0);
    expect(row['outcome']).toBeNull();
  });

  it('two separate handoffs each produce their own distinct row, not an overwrite', () => {
    const conn = freshDb();
    insertNode(conn, 'A', 1, 'FILE_STATE', 'first content');

    const manifest = compileManifest(conn, 1000, {
      resumeInstruction: 'resume',
      fsmState: 'IDE_IDLE',
    });

    const first = writeManifestLogEntry(conn, manifest, 1_000);
    const second = writeManifestLogEntry(conn, manifest, 2_000);

    expect(first.id).not.toBe(second.id);

    const rows = conn.prepare('SELECT id, created_at FROM manifest_log ORDER BY created_at').all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['id'])).toEqual([first.id, second.id]);
  });

  it('the manifest_log row exists and is correct before clipboard delivery is even attempted', async () => {
    const conn = freshDb();
    insertNode(conn, 'A', 1, 'FILE_STATE', 'content');

    const manifest = compileManifest(conn, 1000, {
      resumeInstruction: 'resume',
      fsmState: 'IDE_IDLE',
    });

    const entry = writeManifestLogEntry(conn, manifest);

    // Log row is already correct at this point, strictly before any delivery call.
    const rowBeforeDelivery = conn
      .prepare('SELECT * FROM manifest_log WHERE id = ?')
      .get(entry.id) as Record<string, unknown>;
    expect(rowBeforeDelivery).toBeDefined();
    expect(rowBeforeDelivery['outcome']).toBeNull();

    const { copyManifestToClipboard } = await import('./clipboard.js');
    await copyManifestToClipboard(manifest);

    // Delivery does not retroactively change the already-written log row.
    const rowAfterDelivery = conn
      .prepare('SELECT * FROM manifest_log WHERE id = ?')
      .get(entry.id) as Record<string, unknown>;
    expect(rowAfterDelivery).toEqual(rowBeforeDelivery);
    expect(conn.prepare('SELECT COUNT(*) AS cnt FROM manifest_log').get()).toEqual({ cnt: 1 });
  });
});
