import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { program } from './program.js';
import { stenoDir } from '../workspace/sandbox.js';
import { stenodInit } from '../daemon/init.js';
import { installTrustStore, UnsupportedPlatformError } from '../network/trust-store.js';
import type { TrustStoreCommandResult } from '../network/trust-store.js';

/**
 * Phase 12.4 — Wire `stenod enable-network-capture` CLI Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] command correctly triggers 12.1–12.3 in sequence, with a clear
 *       explanation shown to the user before acting
 *
 * Verify line: "CLI invocation test."
 *
 * `installTrustStore` (Phase 12.1) is the one step in this sequence that
 * touches real OS state (the per-user trust store) — Phase 12.1's own test
 * suite (`network/trust-store.test.ts`) already proves that function's
 * correctness for real, gated to Linux CI only, against an isolated scratch
 * NSS DB (never a real developer machine's actual trust store). This file
 * does not repeat that: `installTrustStore` is mocked here (`vi.mock` with
 * `importOriginal`, so the real `UnsupportedPlatformError` class and every
 * other export of `trust-store.js` stay real) so this phase's CLI-wiring
 * tests are fully deterministic and safe to run on any platform/CI,
 * including this project's own Windows dev machines, without ever risking
 * a real trust-store mutation or accidentally invoking Windows's own
 * unrelated `certutil.exe` (Microsoft's CryptoAPI tool — see
 * `trust-store.test.ts`'s header for why that's a real risk, not
 * hypothetical). The "unsupported platform" test below exercises the CLI's
 * error handling for the real `UnsupportedPlatformError` class by having
 * the mock throw one directly — this is deterministic on every platform
 * (not conditional on which OS happens to be running the suite), unlike
 * relying on the actual host platform to naturally hit that branch.
 */
vi.mock('../network/trust-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../network/trust-store.js')>();
  return {
    ...actual,
    installTrustStore: vi.fn(),
  };
});

const SUCCESSFUL_INSTALL: TrustStoreCommandResult = {
  success: true,
  platform: process.platform,
  stdout: '',
  stderr: '',
};

describe('cli/enable-network-capture — Phase 12.4', () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  program.exitOverride();

  function makeInitializedRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-cli-network-capture-test-'));
    tempDirs.push(dir);
    stenodInit(dir, { reset: false });
    return dir;
  }

  /**
   * Invokes every SIGINT/SIGTERM handler registered during a test, then
   * removes it. Neutralizes `process.exit` first — the real handler's own
   * try/catch wraps its `process.exit(0)` call, so vitest's real (test-safe)
   * `process.exit` throwing would otherwise be caught and misreported as a
   * shutdown failure, triggering a second `process.exit(1)` call. Mirrors
   * `start-stop.test.ts`'s identical precaution for the same code shape.
   */
  async function stopAnyRunningCapture(onSpy: ReturnType<typeof vi.spyOn>): Promise<void> {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    const calls = onSpy.mock.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
    for (const [event, handler] of calls) {
      if (event !== 'SIGINT' && event !== 'SIGTERM') continue;
      await handler();
      process.off(event, handler as (...args: unknown[]) => void);
    }
  }

  afterEach(async () => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors cleanly when the directory was never `stenod init`-ed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stenod-cli-network-capture-uninit-'));
    tempDirs.push(root);
    process.chdir(root);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['enable-network-capture'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stenod init'));
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(installTrustStore)).not.toHaveBeenCalled();
  });

  it('reports a clean error and exits 1, without starting the proxy, when the trust store install is unsupported on this platform', async () => {
    vi.mocked(installTrustStore).mockImplementation(() => {
      throw new UnsupportedPlatformError('win32', 'installation');
    });
    const root = makeInitializedRoot();
    process.chdir(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSpy = vi.spyOn(process, 'on');

    await program.parseAsync(['enable-network-capture'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('trust-store installation is not supported on platform "win32"')
    );
    expect(process.exitCode).toBe(1);
    // No SIGINT/SIGTERM handler registered — the proxy never started, since
    // installTrustStore() throws before createProviderCaptureProxy() runs.
    expect(onSpy.mock.calls.some(([event]) => event === 'SIGINT' || event === 'SIGTERM')).toBe(false);
  });

  it('shows a clear explanation of what will happen before acting', async () => {
    vi.mocked(installTrustStore).mockReturnValue(SUCCESSFUL_INSTALL);
    const root = makeInitializedRoot();
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const onSpy = vi.spyOn(process, 'on');

    await program.parseAsync(['enable-network-capture'], { from: 'user' });

    const allLogged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogged).toContain('local root CA');
    expect(allLogged).toContain('OS trust store');
    expect(allLogged).toContain('HTTPS proxy');
    expect(allLogged).toContain('api.anthropic.com');
    expect(allLogged).toContain('disable-network-capture');

    // The explanation must appear before the CA is actually generated/installed.
    const explanationIdx = logSpy.mock.calls.findIndex((c) => String(c[0]).includes('local root CA'));
    const installedIdx = logSpy.mock.calls.findIndex((c) => String(c[0]).includes('Root CA installed'));
    expect(explanationIdx).toBeGreaterThanOrEqual(0);
    expect(installedIdx).toBeGreaterThan(explanationIdx);

    await stopAnyRunningCapture(onSpy);
  });

  it('triggers CA generation, trust store install, proxy start, and capture attachment in sequence, then stops cleanly on SIGINT', async () => {
    vi.mocked(installTrustStore).mockReturnValue(SUCCESSFUL_INSTALL);
    const root = makeInitializedRoot();
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSpy = vi.spyOn(process, 'on');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);

    await program.parseAsync(['enable-network-capture'], { from: 'user' });

    // Phase 12.1: a real CA was generated and persisted to disk (not mocked).
    const certPath = join(stenoDir(root), 'ca', 'rootCA.pem');
    expect(existsSync(certPath)).toBe(true);

    // installTrustStore() was called with that exact, real cert path — proves
    // the real generateRootCa()/persistRootCa() output actually flows into it.
    expect(vi.mocked(installTrustStore)).toHaveBeenCalledWith(certPath);

    const allLogged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogged).toContain('Trust store install: succeeded');
    expect(allLogged).toMatch(/Proxy listening at: https:\/\//);
    expect(allLogged).toContain('HTTP_PROXY=');
    expect(allLogged).toContain('HTTPS_PROXY=');
    expect(allLogged).toContain('Press Ctrl+C');

    // Phase 12.2/12.3: a SIGINT/SIGTERM handler was registered — the proxy
    // (and its attached capture) is genuinely running, not a stub that
    // returned immediately.
    const sigintCall = onSpy.mock.calls.find((call) => call[0] === 'SIGINT');
    expect(sigintCall, 'expected enable-network-capture to register a SIGINT handler').toBeDefined();
    const handler = sigintCall![1] as () => Promise<void>;

    await handler();

    expect(exitSpy).toHaveBeenCalledWith(0);
    const allLoggedAfterStop = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLoggedAfterStop).toContain('network capture stopped');

    for (const call of onSpy.mock.calls) {
      if (call[0] === 'SIGTERM' || call[0] === 'SIGINT') {
        process.off(call[0] as string, call[1] as (...args: unknown[]) => void);
      }
    }
  });

  it('a failed trust store install is reported clearly, but the proxy still starts', async () => {
    vi.mocked(installTrustStore).mockReturnValue({
      success: false,
      platform: process.platform,
      stdout: '',
      stderr: 'certutil: command not found',
    });
    const root = makeInitializedRoot();
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSpy = vi.spyOn(process, 'on');

    await program.parseAsync(['enable-network-capture'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('trust store install failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('certutil: command not found'));

    const allLogged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogged).toContain('Trust store install: FAILED');
    expect(allLogged).toMatch(/Proxy listening at: https:\/\//);

    await stopAnyRunningCapture(onSpy);
  });
});
