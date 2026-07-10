import { describe, it, expect, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { program } from './program.js';
import { attachWorkspace, detachWorkspace, pidLockPath } from '../workspace/sandbox.js';

/**
 * Phase 10.3 — Wire `stenod start` / `stenod stop` Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] each command correctly invokes its underlying implementation
 *
 * `stop` is tested by simulating lock-file states directly (Phase 2.1's
 * `attachWorkspace()`) and mocking `process.kill` — never sending a real
 * OS signal to the test process itself, since `process.kill(pid, 'SIGTERM')`
 * aimed at your own PID is not safely mockable-around on Windows (Node
 * cannot deliver a graceful SIGTERM there; it terminates the process
 * outright — see Node's documented Windows signal limitations).
 *
 * `start`'s graceful-shutdown wiring (the SIGINT/SIGTERM handler it
 * registers) is verified by capturing the handler `process.on()` was given
 * and invoking it directly — again without ever sending a real signal or
 * calling the real `process.exit`. The one test that calls the real
 * `startDaemon()` (which also opens a real node-pty terminal capture) is
 * gated `isWindows`-off, mirroring the exact precedent already set by
 * `daemon/lifecycle.test.ts`'s own full start/stop integration test — it
 * will run for real in CI (Ubuntu, per Phase 0.5) but is skipped on a local
 * Windows dev machine.
 */
describe('cli/start+stop — Phase 10.3', () => {
  const isWindows = os.platform() === 'win32';
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  program.exitOverride();

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-cli-start-stop-test-'));
    tempDirs.push(dir);
    return dir;
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

  // ── `stenod start` ────────────────────────────────────────────────────────

  it('running `stenod start` on an already-locked root surfaces a clean error, not a thrown exception', async () => {
    const root = makeTempRoot();
    attachWorkspace(root); // simulates a live daemon already holding the Phase 2.1 lock
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['start', '--foreground'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('workspace already locked'));
    expect(process.exitCode).toBe(1);

    detachWorkspace(root);
  });

  it('honors --project-root instead of defaulting to cwd', async () => {
    const targetRoot = makeTempRoot();
    const unrelatedCwd = makeTempRoot();
    attachWorkspace(targetRoot); // live lock on the *target*, not on cwd
    process.chdir(unrelatedCwd);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['start', '--foreground', '--project-root', targetRoot], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(targetRoot));
    expect(process.exitCode).toBe(1);

    detachWorkspace(targetRoot);
  });

  it('a SIGTERM after `stenod start` gracefully stops the daemon and releases the lock (Unix/Mac only)', async () => {
    if (isWindows) return;

    const root = makeTempRoot();
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const onSpy = vi.spyOn(process, 'on');
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);

    await program.parseAsync(['start', '--foreground'], { from: 'user' });

    const sigtermCall = onSpy.mock.calls.find((call) => call[0] === 'SIGTERM');
    expect(sigtermCall, 'expected start to register a SIGTERM handler').toBeDefined();
    const handler = sigtermCall![1] as () => Promise<void>;

    await handler();

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(existsSync(pidLockPath(root))).toBe(false);

    // Clean up listeners this test registered on the real process object.
    for (const call of onSpy.mock.calls) {
      if (call[0] === 'SIGTERM' || call[0] === 'SIGINT') {
        process.off(call[0] as string, call[1] as (...args: unknown[]) => void);
      }
    }
  });

  // ── `stenod stop` ────────────────────────────────────────────────────────

  it('reports no daemon running when there is no lock file', async () => {
    const root = makeTempRoot();
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await program.parseAsync(['stop'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no daemon running'));
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('reports no daemon running for a stale lock (dead PID), without sending a signal', async () => {
    const root = makeTempRoot();
    attachWorkspace(root);
    detachWorkspace(root); // releases the lock; .stenod/ stays behind
    // A PID astronomically unlikely to be alive — simulates a stale lock
    // left behind by a crashed daemon.
    writeFileSync(pidLockPath(root), '999999999', 'utf8');
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // getDaemonStatus()'s own liveness probe also goes through process.kill
    // (signal 0) — only fake a "dead" answer for that probe, so this mock
    // doesn't accidentally validate the stop command against a lie about
    // whether the lock is actually stale.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) {
        const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });

    await program.parseAsync(['stop'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no daemon running'));
    expect(killSpy).not.toHaveBeenCalledWith(expect.anything(), 'SIGTERM');

    if (existsSync(pidLockPath(root))) unlinkSync(pidLockPath(root));
  });

  it('sends SIGTERM to a live daemon and reports stopped once the lock clears', async () => {
    const root = makeTempRoot();
    attachWorkspace(root); // live lock, pid = process.pid (genuinely alive)
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      // Simulate the signaled process performing its own graceful
      // stopDaemon() -> detachWorkspace(), which removes the lock file.
      setTimeout(() => {
        if (existsSync(pidLockPath(root))) unlinkSync(pidLockPath(root));
      }, 20);
      return true;
    });

    await program.parseAsync(['stop'], { from: 'user' });

    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stenod daemon stopped'));
    expect(existsSync(pidLockPath(root))).toBe(false);
  });
});
