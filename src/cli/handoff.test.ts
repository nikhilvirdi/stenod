import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import clipboard from 'clipboardy';
import { program } from './program.js';
import { openDatabase, runMigrations } from '../storage/index.js';
import { stenoDir } from '../workspace/sandbox.js';
import type { CompiledManifest } from '../compiler/index.js';

/**
 * Phase 10.4 — Wire `stenod handoff` (+worked/failed) Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] `stenod handoff`, `stenod handoff --worked`, `stenod handoff
 *       --failed` all behave correctly end to end
 *
 * `clipboardy` is mocked rather than touching the real OS clipboard — same
 * rationale as `delivery/clipboard.test.ts`'s header comment (a real
 * round-trip is inherently racy against any other clipboard activity
 * during the run).
 */
vi.mock('clipboardy', () => ({
  default: {
    write: vi.fn(),
    read: vi.fn(),
  },
}));

describe('cli/handoff — Phase 10.4', () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  program.exitOverride();

  function makeInitializedRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-cli-handoff-test-'));
    tempDirs.push(dir);
    mkdirSync(stenoDir(dir), { recursive: true });
    const db = openDatabase(join(stenoDir(dir), 'graph.db'));
    runMigrations(db);
    db.close();
    return dir;
  }

  function insertNode(
    root: string,
    id: string,
    eventId: number,
    type: string,
    content: string,
    fsmState = 'IDE_IDLE',
    createdAt: number = Date.now()
  ): void {
    const db = openDatabase(join(stenoDir(root), 'graph.db'));
    db.prepare(
      `INSERT INTO graph_nodes
         (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'ACTIVE', NULL, ?)`
    ).run(id, eventId, type, content, fsmState, createdAt);
    db.close();
  }

  function readManifestLogRows(root: string): Array<Record<string, unknown>> {
    const db = openDatabase(join(stenoDir(root), 'graph.db'));
    const rows = db.prepare('SELECT * FROM manifest_log ORDER BY created_at ASC').all() as Array<
      Record<string, unknown>
    >;
    db.close();
    return rows;
  }

  beforeEach(() => {
    vi.mocked(clipboard.write).mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── `stenod handoff` (compile + log + deliver) ──────────────────────────

  it('errors cleanly when the directory was never `stenod init`-ed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stenod-cli-handoff-uninit-'));
    tempDirs.push(root);
    process.chdir(root);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['handoff'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stenod init'));
    expect(process.exitCode).toBe(1);
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it('compiles a manifest from real DB rows, writes exactly one manifest_log row, and copies it to the clipboard', async () => {
    const root = makeInitializedRoot();
    insertNode(root, 'C1', 1, 'CONSTRAINT', 'always use TypeScript strict mode');
    insertNode(root, 'A', 2, 'FILE_STATE', 'export const x = 1;');
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['handoff'], { from: 'user' });

    expect(clipboard.write).toHaveBeenCalledTimes(1);
    const written = JSON.parse(vi.mocked(clipboard.write).mock.calls[0][0]) as CompiledManifest;
    expect(written.primacyZone.map((n) => n.id)).toEqual(['C1']);
    expect(written.middleZone.map((n) => n.id)).toEqual(['A']);
    expect(written.recencyZone.resumeInstruction).toBeTruthy();

    const rows = readManifestLogRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]['outcome']).toBeNull();
    expect(JSON.parse(rows[0]['node_ids'] as string)).toEqual(['C1', 'A']);
  });

  it('an empty project (no nodes) still produces a valid empty manifest and a manifest_log row', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['handoff'], { from: 'user' });

    const written = JSON.parse(vi.mocked(clipboard.write).mock.calls[0][0]) as CompiledManifest;
    expect(written.primacyZone).toEqual([]);
    expect(written.middleZone).toEqual([]);

    const rows = readManifestLogRows(root);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]['node_ids'] as string)).toEqual([]);
  });

  it('derives fsmState + unresolvedErrorContext from the most recent ACTIVE nodes, surfacing a Next Actions block', async () => {
    const root = makeInitializedRoot();
    insertNode(root, 'E1', 1, 'TERMINAL_ERROR', 'TypeError at src/foo.ts:12', 'RUNTIME_ERR', Date.now() - 1000);
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['handoff'], { from: 'user' });

    const written = JSON.parse(vi.mocked(clipboard.write).mock.calls[0][0]) as CompiledManifest;
    expect(written.recencyZone.nextActions?.message).toContain('TypeError at src/foo.ts:12');
  });

  it('rejects a non-numeric --token-budget without touching the clipboard or manifest_log', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['handoff', '--token-budget', 'not-a-number'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--token-budget'));
    expect(process.exitCode).toBe(1);
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(readManifestLogRows(root)).toHaveLength(0);
  });

  it('honors a custom --token-budget (tight budget excludes lower-utility nodes)', async () => {
    const root = makeInitializedRoot();
    insertNode(root, 'C1', 1, 'CONSTRAINT', 'always use TypeScript strict mode');
    insertNode(root, 'BIG', 2, 'FILE_STATE', 'x'.repeat(4000));
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['handoff', '--token-budget', '5'], { from: 'user' });

    const written = JSON.parse(vi.mocked(clipboard.write).mock.calls[0][0]) as CompiledManifest;
    // CONSTRAINT is force-included regardless of budget (Phase 8.4); the
    // large FILE_STATE node cannot fit in a 5-token budget.
    expect(written.primacyZone.map((n) => n.id)).toEqual(['C1']);
    expect(written.middleZone.map((n) => n.id)).not.toContain('BIG');
  });

  // ── `stenod handoff --worked` / `--failed` (tagging only) ───────────────

  it('rejects passing both --worked and --failed together', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['handoff', '--worked', '--failed'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('both --worked and --failed'));
    expect(process.exitCode).toBe(1);
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it('--worked tags the most recent manifest_log row without compiling a new manifest', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['handoff'], { from: 'user' });
    expect(clipboard.write).toHaveBeenCalledTimes(1);

    await program.parseAsync(['handoff', '--worked'], { from: 'user' });

    // --worked must not trigger a second compile+deliver cycle.
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    const rows = readManifestLogRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]['outcome']).toBe('WORKED');
  });

  it('--failed tags the most recent manifest_log row', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['handoff'], { from: 'user' });
    await program.parseAsync(['handoff', '--failed'], { from: 'user' });

    const rows = readManifestLogRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]['outcome']).toBe('FAILED');
  });

  it('--worked on an empty manifest_log (no prior handoff) is a friendly no-op, not a crash', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['handoff', '--worked'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no manifest_log entries'));
    expect(readManifestLogRows(root)).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('only the most recent of two manifest_log rows gets tagged', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['handoff'], { from: 'user' });
    await program.parseAsync(['handoff'], { from: 'user' });
    await program.parseAsync(['handoff', '--worked'], { from: 'user' });

    const rows = readManifestLogRows(root);
    expect(rows).toHaveLength(2);
    expect(rows[0]['outcome']).toBeNull();
    expect(rows[1]['outcome']).toBe('WORKED');
  });
});
