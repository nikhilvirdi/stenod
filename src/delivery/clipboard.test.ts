import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import clipboard from 'clipboardy';
import { openDatabase, runMigrations } from '../storage/index.js';
import { compileManifest } from '../compiler/index.js';
import type { CompiledManifest } from '../compiler/index.js';
import { copyManifestToClipboard } from './clipboard.js';

/**
 * Phase 9.1 — Clipboard Delivery Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Compiled manifest correctly lands on the system clipboard
 *
 * Verify line: "integration test reading clipboard content after a
 * handoff call." A real OS clipboard round trip via `clipboardy` — no
 * mocking of the clipboard backend.
 */
describe('delivery/clipboard — Phase 9.1', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  afterEach(() => {
    if (db) {
      db.close();
      db = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a manifest compiled from a real DB lands on the system clipboard, byte-for-byte as JSON', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-clipboard-test-'));
    db = openDatabase(join(tempDir, 'graph.db'));
    runMigrations(db);

    db.prepare(
      `INSERT INTO graph_nodes
         (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
       VALUES ('C1', 1, 'CONSTRAINT', 'always use TypeScript strict mode', 'IDE_IDLE', 'lang-strictness', 'ACTIVE', NULL, ?)`
    ).run(Date.now() - 60_000);
    db.prepare(
      `INSERT INTO graph_nodes
         (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
       VALUES ('A', 2, 'FILE_STATE', 'export const x = 1;', 'RUNTIME_ERR', NULL, 'ACTIVE', NULL, ?)`
    ).run(Date.now() - 10_000);

    const manifest = compileManifest(db, 1000, {
      resumeInstruction: 'pick up where you left off',
      fsmState: 'RUNTIME_ERR',
      unresolvedErrorContext: 'TypeError at src/foo.ts:12',
    });

    await copyManifestToClipboard(manifest);

    const clipboardContent = await clipboard.read();
    expect(clipboardContent).toBe(JSON.stringify(manifest));

    // Sanity: this is a real, non-trivial manifest, not an accidental empty-string pass.
    expect(manifest.primacyZone.map((n) => n.id)).toEqual(['C1']);
    expect(clipboardContent).toContain('"resumeInstruction":"pick up where you left off"');
  });

  it('a manifest with empty zones and no Next Actions block still lands correctly on the clipboard', async () => {
    const manifest: CompiledManifest = {
      primacyZone: [],
      middleZone: [],
      recencyZone: { resumeInstruction: 'nothing to resume' },
    };

    await copyManifestToClipboard(manifest);

    const clipboardContent = await clipboard.read();
    expect(clipboardContent).toBe(JSON.stringify(manifest));
    expect(clipboardContent).not.toContain('nextActions');
  });
});
