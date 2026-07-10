import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { program } from './program.js';
import { openDatabase, runMigrations } from '../storage/index.js';
import { stenoDir } from '../workspace/sandbox.js';

/**
 * Phase 10.6 — Wire `stenod anchor` CLI Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] `stenod anchor "<text>"` correctly creates a `CONSTRAINT` node
 *
 * Verify line: "CLI invocation test, inspect resulting node."
 */
describe('cli/anchor — Phase 10.6', () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  program.exitOverride();

  function makeInitializedRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-cli-anchor-test-'));
    tempDirs.push(dir);
    mkdirSync(stenoDir(dir), { recursive: true });
    const db = openDatabase(join(stenoDir(dir), 'graph.db'));
    runMigrations(db);
    db.close();
    return dir;
  }

  function queryConstraintNodes(root: string): Array<Record<string, unknown>> {
    const db = openDatabase(join(stenoDir(root), 'graph.db'));
    const rows = db
      .prepare("SELECT * FROM graph_nodes WHERE type = 'CONSTRAINT' ORDER BY event_id ASC")
      .all() as Array<Record<string, unknown>>;
    db.close();
    return rows;
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
    const root = mkdtempSync(join(tmpdir(), 'stenod-cli-anchor-uninit-'));
    tempDirs.push(root);
    process.chdir(root);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['anchor', 'always use TypeScript strict mode'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stenod init'));
    expect(process.exitCode).toBe(1);
  });

  it('creates a CONSTRAINT node from free text with no key', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['anchor', 'always use TypeScript strict mode'], { from: 'user' });

    const rows = queryConstraintNodes(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]['content']).toBe('always use TypeScript strict mode');
    expect(rows[0]['constraint_key']).toBeNull();
    expect(rows[0]['status']).toBe('ACTIVE');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Anchored CONSTRAINT node'));
  });

  it('creates a CONSTRAINT node with a key from "key=value" text', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(
      ['anchor', 'lang-strictness=always use TypeScript strict mode'],
      { from: 'user' }
    );

    const rows = queryConstraintNodes(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]['constraint_key']).toBe('lang-strictness');
    expect(rows[0]['content']).toBe('always use TypeScript strict mode');
  });

  it('a second anchor with the same key supersedes the first (LWW), correctly triggered from the CLI', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['anchor', 'lang-strictness=always use TypeScript strict mode'], {
      from: 'user',
    });
    await program.parseAsync(['anchor', 'lang-strictness=actually, allow implicit any'], {
      from: 'user',
    });

    const rows = queryConstraintNodes(root);
    expect(rows).toHaveLength(2);
    expect(rows[0]['status']).toBe('SUPERSEDED');
    expect(rows[1]['status']).toBe('ACTIVE');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Superseded 1 prior constraint'));
  });

  it('re-anchoring identical text reports no change instead of duplicating the node', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['anchor', 'k=identical text'], { from: 'user' });
    await program.parseAsync(['anchor', 'k=identical text'], { from: 'user' });

    expect(queryConstraintNodes(root)).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no change'));
  });
});
