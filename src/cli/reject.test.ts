import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { program } from './program.js';
import { openDatabase, runMigrations } from '../storage/index.js';
import { stenoDir } from '../workspace/sandbox.js';

/**
 * Phase 10.5 — Wire `stenod reject --since` Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] duration parsing + rejection logic correctly triggered from CLI
 *
 * Verify line: "CLI invocation test with a controlled fixture graph" —
 * mirrors `lifecycle/reject.test.ts`'s own fixture style (nodes at
 * controlled timestamps straddling the window boundary), but driven
 * through the CLI's `reject --since` command instead of calling
 * `rejectSince()` directly.
 */
describe('cli/reject — Phase 10.5', () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  program.exitOverride();

  function makeInitializedRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-cli-reject-test-'));
    tempDirs.push(dir);
    mkdirSync(stenoDir(dir), { recursive: true });
    const db = openDatabase(join(stenoDir(dir), 'graph.db'));
    runMigrations(db);
    db.close();
    return dir;
  }

  function insertNode(root: string, id: string, status: string, createdAt: number): void {
    const db = openDatabase(join(stenoDir(root), 'graph.db'));
    db.prepare(
      `INSERT INTO graph_nodes
         (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
       VALUES (?, 1, 'FILE_STATE', 'content', 'IDE_IDLE', NULL, ?, NULL, ?)`
    ).run(id, status, createdAt);
    db.close();
  }

  function readStatus(root: string, id: string): string {
    const db = openDatabase(join(stenoDir(root), 'graph.db'));
    const row = db.prepare('SELECT status FROM graph_nodes WHERE id = ?').get(id) as {
      status: string;
    };
    db.close();
    return row.status;
  }

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors cleanly when the directory was never `stenod init`-ed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stenod-cli-reject-uninit-'));
    tempDirs.push(root);
    process.chdir(root);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['reject', '--since', '15m'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stenod init'));
    expect(process.exitCode).toBe(1);
  });

  it('flips nodes inside the window to REJECTED and leaves nodes outside it untouched', async () => {
    const root = makeInitializedRoot();
    const now = 1_000_000;
    // 15m window = 900,000ms. Cutoff = 100,000.
    insertNode(root, 'tooOld', 'ACTIVE', 50_000); // outside
    insertNode(root, 'inWindow', 'ACTIVE', 150_000); // inside
    vi.spyOn(Date, 'now').mockReturnValue(now);
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['reject', '--since', '15m'], { from: 'user' });

    expect(readStatus(root, 'tooOld')).toBe('ACTIVE');
    expect(readStatus(root, 'inWindow')).toBe('REJECTED');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Rejected 1 node'));
  });

  it('does not touch already-non-ACTIVE nodes even inside the window', async () => {
    const root = makeInitializedRoot();
    const now = 1_000_000;
    insertNode(root, 'superseded', 'SUPERSEDED', 500_000);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['reject', '--since', '15m'], { from: 'user' });

    expect(readStatus(root, 'superseded')).toBe('SUPERSEDED');
  });

  it('rejects an invalid --since duration format with a clean error, mutating nothing', async () => {
    const root = makeInitializedRoot();
    insertNode(root, 'a', 'ACTIVE', Date.now());
    process.chdir(root);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['reject', '--since', 'not-a-duration'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid duration'));
    expect(process.exitCode).toBe(1);
    expect(readStatus(root, 'a')).toBe('ACTIVE');
  });

  it('requires --since (commander enforces the required option)', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(program.parseAsync(['reject'], { from: 'user' })).rejects.toThrow();
  });
});
