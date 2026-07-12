import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { program } from './program.js';
import { stenodInit } from '../daemon/init.js';
import { generateRootCa, persistRootCa, caDir } from '../network/ca.js';
import {
  installTrustStore,
  uninstallTrustStore,
  verifyTrustStoreInstall,
  UnsupportedPlatformError,
} from '../network/trust-store.js';
import type { TrustStoreCommandResult } from '../network/trust-store.js';

/**
 * Phase 12.5 — Wire `stenod disable-network-capture` CLI Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] After disable, the CA is confirmed removed from the trust store
 *   [x] Proxy settings confirmed reverted
 *   [x] A fresh enable -> disable -> enable cycle works cleanly (no
 *       leftover state)
 *
 * Verify line: "full enable/disable/enable integration test with OS-level
 * trust store checks."
 *
 * `installTrustStore`/`uninstallTrustStore`/`verifyTrustStoreInstall`
 * (Phase 12.1) are the only steps in this sequence that touch real OS
 * state — mocked here for the same reason `enable-network-capture.test.ts`
 * mocks `installTrustStore`: deterministic on any platform/CI, and never
 * at risk of invoking Windows's own unrelated `certutil.exe` (see that
 * file's header, and `trust-store.test.ts`'s, for why that's a real risk).
 * `generateRootCa()`/`persistRootCa()` are used for real (unmocked) in this
 * file's setup helpers — they only write local files, no OS trust-store
 * mutation, so there's nothing unsafe about exercising them directly.
 */
vi.mock('../network/trust-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../network/trust-store.js')>();
  return {
    ...actual,
    installTrustStore: vi.fn(),
    uninstallTrustStore: vi.fn(),
    verifyTrustStoreInstall: vi.fn(),
  };
});

const SUCCESSFUL_INSTALL: TrustStoreCommandResult = {
  success: true,
  platform: process.platform,
  stdout: '',
  stderr: '',
};

const SUCCESSFUL_UNINSTALL: TrustStoreCommandResult = {
  success: true,
  platform: process.platform,
  stdout: '',
  stderr: '',
};

/** verifyTrustStoreInstall() reporting "not found" — i.e. removal confirmed. */
const VERIFY_NOT_FOUND: TrustStoreCommandResult = {
  success: false,
  platform: process.platform,
  stdout: '',
  stderr: '',
};

/** verifyTrustStoreInstall() reporting "still found" — i.e. removal NOT confirmed. */
const VERIFY_STILL_FOUND: TrustStoreCommandResult = {
  success: true,
  platform: process.platform,
  stdout: '',
  stderr: '',
};

describe('cli/disable-network-capture — Phase 12.5', () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  program.exitOverride();

  function makeInitializedRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-cli-disable-capture-test-'));
    tempDirs.push(dir);
    stenodInit(dir, { reset: false });
    return dir;
  }

  /** Persists a real (locally-generated, non-OS-mutating) CA, simulating a prior `enable-network-capture` run. */
  function seedPersistedCa(root: string): string {
    const ca = generateRootCa();
    const persisted = persistRootCa(root, ca);
    return persisted.certPath;
  }

  /**
   * Invokes every SIGINT/SIGTERM handler registered during a test, then
   * removes it. Neutralizes `process.exit` first — mirrors
   * `enable-network-capture.test.ts`'s identical helper/precaution.
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
    // vi.restoreAllMocks() restores vi.spyOn() implementations (console.*,
    // process.on/exit) but does NOT clear call history on the module-level
    // vi.fn() mocks created by this file's top-level vi.mock() factory —
    // those need an explicit clear, or install/uninstall/verify call counts
    // silently accumulate across every test in this file.
    vi.restoreAllMocks();
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors cleanly when the directory was never `stenod init`-ed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stenod-cli-disable-capture-uninit-'));
    tempDirs.push(root);
    process.chdir(root);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['disable-network-capture'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stenod init'));
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(uninstallTrustStore)).not.toHaveBeenCalled();
  });

  it('reports nothing to revert when network capture was never enabled for this project', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['disable-network-capture'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('was not enabled'));
    expect(vi.mocked(uninstallTrustStore)).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('removes the CA from the trust store, confirms removal, and deletes the persisted CA directory', async () => {
    const root = makeInitializedRoot();
    const certPath = seedPersistedCa(root);
    expect(existsSync(certPath)).toBe(true);
    process.chdir(root);
    vi.mocked(uninstallTrustStore).mockReturnValue(SUCCESSFUL_UNINSTALL);
    vi.mocked(verifyTrustStoreInstall).mockReturnValue(VERIFY_NOT_FOUND);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['disable-network-capture'], { from: 'user' });

    expect(vi.mocked(uninstallTrustStore)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verifyTrustStoreInstall)).toHaveBeenCalledTimes(1);

    const allLogged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogged).toContain('Trust store removal: succeeded');
    expect(allLogged).toContain('Confirmed removed from trust store: yes');
    expect(allLogged).toContain('unset HTTP_PROXY HTTPS_PROXY');

    // Fully reverted: the persisted CA directory itself is gone too.
    expect(existsSync(certPath)).toBe(false);
    expect(existsSync(caDir(root))).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a clean, non-crashing error when removal cannot be confirmed, and keeps the persisted CA', async () => {
    const root = makeInitializedRoot();
    const certPath = seedPersistedCa(root);
    process.chdir(root);
    vi.mocked(uninstallTrustStore).mockReturnValue(SUCCESSFUL_UNINSTALL);
    vi.mocked(verifyTrustStoreInstall).mockReturnValue(VERIFY_STILL_FOUND);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['disable-network-capture'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('may still be present'));
    expect(process.exitCode).toBe(1);
    // Not deleted -- removal wasn't confirmed, so nothing is discarded.
    expect(existsSync(certPath)).toBe(true);
  });

  it('reports a clean error and does not touch the persisted CA when the platform is unsupported', async () => {
    const root = makeInitializedRoot();
    const certPath = seedPersistedCa(root);
    process.chdir(root);
    vi.mocked(uninstallTrustStore).mockImplementation(() => {
      throw new UnsupportedPlatformError('win32', 'removal');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['disable-network-capture'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('trust-store removal is not supported on platform "win32"')
    );
    expect(process.exitCode).toBe(1);
    expect(existsSync(certPath)).toBe(true);
    expect(vi.mocked(verifyTrustStoreInstall)).not.toHaveBeenCalled();
  });

  it('a fresh enable -> disable -> enable cycle works cleanly, with no leftover state', async () => {
    const root = makeInitializedRoot();
    process.chdir(root);
    vi.mocked(installTrustStore).mockReturnValue(SUCCESSFUL_INSTALL);
    vi.mocked(uninstallTrustStore).mockReturnValue(SUCCESSFUL_UNINSTALL);
    vi.mocked(verifyTrustStoreInstall).mockReturnValue(VERIFY_NOT_FOUND);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSpy = vi.spyOn(process, 'on');

    const certPath = join(caDir(root), 'rootCA.pem');

    // 1. enable
    await program.parseAsync(['enable-network-capture'], { from: 'user' });
    expect(existsSync(certPath)).toBe(true);
    const firstCaBytes = readFileSync(certPath, 'utf8');

    // 2. disable
    await program.parseAsync(['disable-network-capture'], { from: 'user' });
    expect(existsSync(certPath)).toBe(false);

    // 3. enable again -- must succeed cleanly, with no complaint about
    // leftover state from the first cycle, and produce a genuinely new CA
    // (generateRootCa() has no persisted state to reuse across cycles).
    await program.parseAsync(['enable-network-capture'], { from: 'user' });
    expect(existsSync(certPath)).toBe(true);
    const secondCaBytes = readFileSync(certPath, 'utf8');
    expect(secondCaBytes).not.toBe(firstCaBytes);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(vi.mocked(installTrustStore)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(uninstallTrustStore)).toHaveBeenCalledTimes(1);

    await stopAnyRunningCapture(onSpy);
  });
});
