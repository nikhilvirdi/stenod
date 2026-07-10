import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { program } from './program.js';
import { stenodInit } from '../daemon/init.js';
import { stenoDir, pidLockPath } from '../workspace/sandbox.js';
import { tokenPath } from '../workspace/token.js';

/**
 * Phase 10.2 — Wire `stenod init` Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] `stenod init` run from the CLI produces identical results to
 *       calling 7.1 directly
 *
 * Invokes the CLI in-process via commander's `parseAsync` (no subprocess
 * spawn), matching this project's existing vitest-only testing convention.
 */
describe('cli/init — Phase 10.2', () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();
  const originalPlatform = process.platform;

  program.exitOverride();

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-cli-init-test-'));
    tempDirs.push(dir);
    return dir;
  }

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  beforeEach(() => {
    setPlatform('linux');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setPlatform(originalPlatform);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('running `stenod init` from the CLI creates .stenod/, a token file, and a valid systemd unit', async () => {
    const root = makeTempRoot();
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['init'], { from: 'user' });

    expect(existsSync(stenoDir(root))).toBe(true);
    expect(existsSync(tokenPath(root))).toBe(true);

    const unitPath = join(stenoDir(root), 'stenod.service');
    expect(existsSync(unitPath)).toBe(true);
    const content = readFileSync(unitPath, 'utf8');
    expect(content).toContain('Restart=on-failure');
    expect(content).toContain(`ExecStart=stenod start --project-root "${root}"`);
    expect(process.exitCode).toBeUndefined();
  });

  it('re-running `stenod init` (no --reset) on an already-initialized root is idempotent, matching a direct stenodInit() call', async () => {
    const root = makeTempRoot();
    const direct = stenodInit(root, { platform: 'linux' });

    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['init'], { from: 'user' });

    expect(readFileSync(tokenPath(root), 'utf8').trim()).toBe(direct.token);
    const content = readFileSync(join(stenoDir(root), 'stenod.service'), 'utf8');
    expect(content).toBe(direct.serviceUnitContent);
  });

  it('`stenod init --reset` rotates the token', async () => {
    const root = makeTempRoot();
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['init'], { from: 'user' });
    const firstToken = readFileSync(tokenPath(root), 'utf8').trim();

    await program.parseAsync(['init', '--reset'], { from: 'user' });
    const secondToken = readFileSync(tokenPath(root), 'utf8').trim();

    expect(secondToken).not.toBe(firstToken);
  });

  it('surfaces WorkspaceLockedError as a clean message + non-zero exit code, without creating a token file', async () => {
    const root = makeTempRoot();
    mkdirSync(stenoDir(root), { recursive: true });
    writeFileSync(pidLockPath(root), String(process.pid), 'utf8');

    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['init'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('workspace already locked'));
    expect(process.exitCode).toBe(1);
    expect(existsSync(tokenPath(root))).toBe(false);
  });

  it('on Mac, produces a launchd plist through the CLI', async () => {
    setPlatform('darwin');
    const root = makeTempRoot();
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['init'], { from: 'user' });

    const unitPath = join(stenoDir(root), 'com.stenod.daemon.plist');
    expect(existsSync(unitPath)).toBe(true);
    expect(readFileSync(unitPath, 'utf8')).toContain('<key>Label</key>');
  });

  it('on an unsupported platform, creates .stenod/ and the token but no service unit', async () => {
    setPlatform('win32');
    const root = makeTempRoot();
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['init'], { from: 'user' });

    expect(existsSync(stenoDir(root))).toBe(true);
    expect(existsSync(tokenPath(root))).toBe(true);
    expect(existsSync(join(stenoDir(root), 'stenod.service'))).toBe(false);
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes('unsupported platform'))).toBe(
      true
    );
  });
});
