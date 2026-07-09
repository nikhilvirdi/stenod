/**
 * Phase 4.1 — chokidar Watcher + Ignore-List Tests
 *
 * SSOT §6.1 / WORKPLAN Phase 4.1 "Done when" checklist:
 *   [x] All listed exclusions verified not to trigger events
 *   [x] .gitignore parsing correctly extends the exclusion set
 *   [x] A normal source file save does trigger an event
 *
 * Strategy: each test builds a real temp directory with fixture files,
 * starts the watcher, writes/touches the fixture, and awaits events
 * (or confirms their absence) with a short timeout.  No mocking of
 * chokidar internals — we verify by observing what actually fires.
 *
 * Total it() blocks: 13
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FSWatcher } from 'chokidar';
import {
  createWatcher,
  loadGitignoreRules,
  isIgnoredByGitignore,
} from './watcher.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** How long to wait (ms) for a file event to arrive before giving up. */
const EVENT_TIMEOUT_MS = 3000;
/** How long to wait (ms) to confirm that NO event arrives. */
const SILENCE_TIMEOUT_MS = 1500;

/**
 * Write (or overwrite) a file, creating parent directories as needed.
 * Suitable for triggering watcher events.
 */
function touch(filePath: string, content = 'x'): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

/**
 * Wait up to `timeoutMs` for `predicate` to become true, polling at
 * 25 ms intervals.  Resolves with true if predicate fires in time,
 * false otherwise.
 */
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

// ── Test suite ───────────────────────────────────────────────────────────────

describe('capture/watcher — Phase 4.1', () => {
  let tempDir: string;
  let watcher: FSWatcher | undefined;

  function setup(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-watcher-test-'));
    return tempDir;
  }

  afterEach(async () => {
    if (watcher) {
      await watcher.close();
      watcher = undefined;
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── 1. Normal source file DOES trigger an event ──────────────────────────

  it('a normal source file save triggers an onChange event', async () => {
    const root = setup();
    const changedPaths: string[] = [];
    watcher = createWatcher(root, { onChange: (p) => changedPaths.push(p) });
    await new Promise<void>((resolve) => watcher!.once('ready', resolve));

    const srcFile = join(root, 'src', 'index.ts');
    touch(srcFile, 'export const x = 1;');

    const fired = await waitFor(() => changedPaths.includes(srcFile), EVENT_TIMEOUT_MS);
    expect(fired, 'Expected event for src/index.ts').toBe(true);
  });

  // ── 2. .git/ exclusion ───────────────────────────────────────────────────

  it('.git/ files do NOT trigger events', async () => {
    const root = setup();
    const changedPaths: string[] = [];
    watcher = createWatcher(root, { onChange: (p) => changedPaths.push(p) });

    touch(join(root, '.git', 'COMMIT_EDITMSG'), 'commit message');

    const fired = await waitFor(() => changedPaths.length > 0, SILENCE_TIMEOUT_MS);
    expect(fired, '.git/ should produce no events').toBe(false);
  });

  // ── 3. node_modules/ exclusion ──────────────────────────────────────────

  it('node_modules/ files do NOT trigger events', async () => {
    const root = setup();
    const changedPaths: string[] = [];
    watcher = createWatcher(root, { onChange: (p) => changedPaths.push(p) });

    touch(join(root, 'node_modules', 'lodash', 'index.js'), 'module.exports={}');

    const fired = await waitFor(() => changedPaths.length > 0, SILENCE_TIMEOUT_MS);
    expect(fired, 'node_modules/ should produce no events').toBe(false);
  });

  // ── 4. dist/ exclusion ──────────────────────────────────────────────────

  it('dist/ files do NOT trigger events', async () => {
    const root = setup();
    const changedPaths: string[] = [];
    watcher = createWatcher(root, { onChange: (p) => changedPaths.push(p) });

    touch(join(root, 'dist', 'index.js'), 'compiled output');

    const fired = await waitFor(() => changedPaths.length > 0, SILENCE_TIMEOUT_MS);
    expect(fired, 'dist/ should produce no events').toBe(false);
  });

  // ── 5. build/ exclusion ─────────────────────────────────────────────────

  it('build/ files do NOT trigger events', async () => {
    const root = setup();
    const changedPaths: string[] = [];
    watcher = createWatcher(root, { onChange: (p) => changedPaths.push(p) });

    touch(join(root, 'build', 'app.js'), 'compiled');

    const fired = await waitFor(() => changedPaths.length > 0, SILENCE_TIMEOUT_MS);
    expect(fired, 'build/ should produce no events').toBe(false);
  });

  // ── 6. target/ exclusion ────────────────────────────────────────────────

  it('target/ files do NOT trigger events', async () => {
    const root = setup();
    const changedPaths: string[] = [];
    watcher = createWatcher(root, { onChange: (p) => changedPaths.push(p) });

    touch(join(root, 'target', 'classes', 'Main.class'), '\x00binary');

    const fired = await waitFor(() => changedPaths.length > 0, SILENCE_TIMEOUT_MS);
    expect(fired, 'target/ should produce no events').toBe(false);
  });

  // ── 7. .next/ exclusion ─────────────────────────────────────────────────

  it('.next/ files do NOT trigger events', async () => {
    const root = setup();
    const changedPaths: string[] = [];
    watcher = createWatcher(root, { onChange: (p) => changedPaths.push(p) });

    touch(join(root, '.next', 'server', 'app.js'), 'nextjs build');

    const fired = await waitFor(() => changedPaths.length > 0, SILENCE_TIMEOUT_MS);
    expect(fired, '.next/ should produce no events').toBe(false);
  });

  // ── 8. .env exclusion ───────────────────────────────────────────────────

  it('.env file does NOT trigger events', async () => {
    const root = setup();
    const changedPaths: string[] = [];
    watcher = createWatcher(root, { onChange: (p) => changedPaths.push(p) });

    touch(join(root, '.env'), 'SECRET_KEY=abc123');

    const fired = await waitFor(() => changedPaths.length > 0, SILENCE_TIMEOUT_MS);
    expect(fired, '.env should produce no events').toBe(false);
  });

  // ── 9. Binary >500 KB exclusion ─────────────────────────────────────────

  it('a file over 500 KB does NOT trigger events', async () => {
    const root = setup();
    const changedPaths: string[] = [];
    watcher = createWatcher(root, { onChange: (p) => changedPaths.push(p) });

    // Write a 501 KB file (all ASCII so definitely >500*1024 bytes).
    const bigFile = join(root, 'large-asset.bin');
    const content = Buffer.alloc(501 * 1024, 0x41); // 501 KB of 'A'
    writeFileSync(bigFile, content);

    const fired = await waitFor(() => changedPaths.length > 0, SILENCE_TIMEOUT_MS);
    expect(fired, 'file >500 KB should produce no events').toBe(false);
  });

  // ── 10. .gitignore extends the exclusion set ─────────────────────────────

  it('.gitignore patterns correctly exclude matching files', async () => {
    const root = setup();
    // Write a .gitignore before starting the watcher.
    touch(join(root, '.gitignore'), '*.log\ncoverage/\n');

    const changedPaths: string[] = [];
    watcher = createWatcher(root, { onChange: (p) => changedPaths.push(p) });

    // These should be ignored.
    touch(join(root, 'debug.log'), 'log output');
    touch(join(root, 'coverage', 'lcov.info'), 'coverage data');

    const fired = await waitFor(() => changedPaths.length > 0, SILENCE_TIMEOUT_MS);
    expect(fired, '.gitignore-matched paths should produce no events').toBe(false);
  });

  // ── 11. .gitignore does NOT affect unrelated files ───────────────────────

  it('files NOT matched by .gitignore still trigger events', async () => {
    const root = setup();
    touch(join(root, '.gitignore'), '*.log\n');

    const changedPaths: string[] = [];
    watcher = createWatcher(root, { onChange: (p) => changedPaths.push(p) });
    await new Promise<void>((resolve) => watcher!.once('ready', resolve));

    const srcFile = join(root, 'src', 'app.ts');
    touch(srcFile, 'export {}');

    const fired = await waitFor(() => changedPaths.includes(srcFile), EVENT_TIMEOUT_MS);
    expect(fired, 'non-ignored file should still trigger an event').toBe(true);
  });

  // ── 12. loadGitignoreRules returns empty array when no .gitignore ────────

  it('loadGitignoreRules returns empty array when .gitignore is absent', () => {
    const root = setup();
    const rules = loadGitignoreRules(root);
    expect(rules).toEqual([]);
  });

  // ── 13. isIgnoredByGitignore correctly classifies paths ─────────────────

  it('isIgnoredByGitignore correctly matches and respects negation rules', () => {
    // Rules: ignore all .log files, but re-include important.log
    const rules = loadGitignoreRules(setup());
    // Build rules manually since there is no .gitignore file.
    const root = setup();
    writeFileSync(join(root, '.gitignore'), '*.log\n!important.log\ncoverage/\n');
    const parsedRules = loadGitignoreRules(root);

    expect(isIgnoredByGitignore('debug.log', parsedRules)).toBe(true);
    expect(isIgnoredByGitignore('important.log', parsedRules)).toBe(false); // negated
    expect(isIgnoredByGitignore('coverage/lcov.info', parsedRules)).toBe(true);
    expect(isIgnoredByGitignore('src/app.ts', parsedRules)).toBe(false);

    // rules from empty setup is unused; suppress lint.
    void rules;
  });
});
