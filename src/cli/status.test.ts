import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { program } from './program.js';
import { attachWorkspace, detachWorkspace } from '../workspace/sandbox.js';

/**
 * Phase 10.3 — Wire `stenod status` Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] each command correctly invokes its underlying implementation
 *
 * Simulates a "live daemon" via `attachWorkspace()` directly (Phase 2.1),
 * the same lightweight technique `daemon/lifecycle.test.ts`'s `fakeHandle()`
 * already uses — this is enough to exercise `getDaemonStatus()`'s PID-lock
 * liveness check without spinning up a real chokidar/node-pty daemon via
 * `startDaemon()`, which `daemon/lifecycle.test.ts` itself only does inside
 * an `isWindows`-gated test (node-pty/ConPTY is out of scope on Windows per
 * SSOT §9).
 */
describe('cli/status — Phase 10.3', () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  program.exitOverride();

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-cli-status-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports not running with zero nodes for a fresh, uninitialized directory', async () => {
    const root = makeTempRoot();
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['status'], { from: 'user' });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Running: false');
    expect(output).toContain('Node count: 0');
    expect(output).toContain('Last event: never');
  });

  it('reports running: true with the correct PID for a live daemon lock', async () => {
    const root = makeTempRoot();
    attachWorkspace(root);
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['status'], { from: 'user' });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Running: true');
    expect(output).toContain(`PID ${process.pid}`);

    detachWorkspace(root);
  });
});
