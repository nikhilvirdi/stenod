import { describe, it, expect, vi, beforeEach } from 'vitest';
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
 * Phase 9.1 — Clipboard Delivery Tests (mocked)
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Compiled manifest correctly lands on the system clipboard
 *
 * These tests mock `clipboardy` rather than touching the real OS
 * clipboard. The OS clipboard is a single shared, global, mutable
 * resource — a real round-trip test racing against ANY other process
 * that writes to the clipboard during the test run (a developer copying
 * text to paste elsewhere, another test, a CI step) produces a false
 * failure with no bug in the code under test. That's not hypothetical:
 * it's exactly what happened during this phase's own review, where a
 * manual clipboard copy during the run overwrote the test's expected
 * content mid-flight.
 *
 * Exactly ONE real, unmocked clipboard round-trip test still exists —
 * see clipboard-live.test.ts — to keep genuine end-to-end confidence
 * that `copyManifestToClipboard` actually reaches the real OS clipboard
 * (SSOT §6.5: clipboard is "the guaranteed path," so that confidence is
 * worth keeping). Every other case (serialization correctness, edge
 * cases, wiring to a real DB-compiled manifest) belongs here instead,
 * against a mocked `clipboardy.write`, so it's fast and can never be
 * racy against unrelated clipboard activity.
 *
 * `vi.mock` calls are hoisted above all imports by vitest's transform,
 * so the static `import clipboard from 'clipboardy'` above resolves to
 * this mock, not the real module — no dynamic-import ordering games
 * needed.
 */
vi.mock('clipboardy', () => ({
  default: {
    write: vi.fn(),
    read: vi.fn(),
  },
}));

describe('delivery/clipboard — Phase 9.1 (mocked clipboardy)', () => {
  beforeEach(() => {
    vi.mocked(clipboard.write).mockClear();
  });

  it('writes the JSON-serialized compiled manifest to clipboardy.write', async () => {
    const manifest: CompiledManifest = {
      primacyZone: [
        {
          id: 'C1',
          type: 'CONSTRAINT',
          status: 'ACTIVE',
          utilityScore: 1,
          contentPreview: 'always use TypeScript strict mode',
          tokenCost: 5,
        },
      ],
      middleZone: [
        {
          id: 'A',
          type: 'FILE_STATE',
          status: 'ACTIVE',
          utilityScore: 0.5,
          contentPreview: 'FILE_STATE in src/a.ts',
          tokenCost: 10,
        },
      ],
      recencyZone: {
        resumeInstruction: 'pick up where you left off',
        nextActions: { message: 'fix the build' },
      },
    };

    await copyManifestToClipboard(manifest);

    expect(clipboard.write).toHaveBeenCalledTimes(1);
    expect(clipboard.write).toHaveBeenCalledWith(JSON.stringify(manifest));
  });

  it('a manifest compiled from a real DB is serialized correctly before being handed to clipboardy.write', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'stenod-clipboard-test-'));
    const db: Database.Database = openDatabase(join(tempDir, 'graph.db'));

    try {
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

      expect(clipboard.write).toHaveBeenCalledWith(JSON.stringify(manifest));
      // Sanity: this is a real, non-trivial manifest, not an accidental empty-string pass.
      expect(manifest.primacyZone.map((n) => n.id)).toEqual(['C1']);
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a manifest with empty zones and no Next Actions block serializes without a nextActions key', async () => {
    const manifest: CompiledManifest = {
      primacyZone: [],
      middleZone: [],
      recencyZone: { resumeInstruction: 'nothing to resume' },
    };

    await copyManifestToClipboard(manifest);

    const written = vi.mocked(clipboard.write).mock.calls[0][0];
    expect(written).toBe(JSON.stringify(manifest));
    expect(written).not.toContain('nextActions');
  });
});
