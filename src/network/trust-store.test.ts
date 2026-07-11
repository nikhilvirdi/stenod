import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  buildInstallCommand,
  buildVerifyCommand,
  buildUninstallCommand,
  installTrustStore,
  verifyTrustStoreInstall,
  uninstallTrustStore,
  UnsupportedPlatformError,
} from './trust-store.js';
import { generateRootCa, ROOT_CA_COMMON_NAME } from './ca.js';

/**
 * Phase 12.1 — Trust Store Command Tests
 *
 * WORKPLAN "Done when" checklist item under test:
 *   [ ] Trust store installation confirmed via OS-level check
 *
 * VERIFICATION STATUS (documented, not hidden — read this before trusting
 * the green checkmark on this file):
 *
 *   - Command *construction* (buildInstallCommand/buildVerifyCommand) is
 *     unit-tested deterministically for every platform branch (platform and
 *     homeDir are both injected — see trust-store.ts's design note),
 *     including confirming `win32` is treated as an explicit unsupported
 *     platform, matching the `daemon/init.ts` precedent.
 *
 *   - LINUX real execution: CLOSED by the "real NSS execution" describe
 *     block below, which actually shells out to the genuine `certutil`
 *     binary against an isolated scratch NSS DB (never the developer's or
 *     CI runner's real per-user trust store) and confirms install + lookup
 *     both really happen. That block is gated on `process.platform ===
 *     'linux'` (via `describe.runIf`) rather than "is a binary named
 *     `certutil` on PATH", because Windows ships its own, unrelated program
 *     also named `certutil.exe` (Microsoft's CryptoAPI tool, incompatible
 *     CLI syntax) — platform-gating avoids any risk of silently invoking
 *     the wrong tool. On a non-Linux host (e.g. this project's own Windows
 *     dev machines) that block is visibly skipped, not silently absent. On
 *     CI (`.github/workflows/ci.yml`, `ubuntu-latest`, which ships
 *     `libnss3-tools` preinstalled — confirmed against the runner image's
 *     own package manifest) it actually executes.
 *
 *   - MACOS real execution: still NOT closeable by this project's CI, ever,
 *     under the current pipeline — `ci.yml` runs `ubuntu-latest` only, by
 *     deliberate design (its own header comment: a macOS/Windows matrix
 *     "would be misleading about what is actually portable today"). No
 *     macOS-executing test logic is added here — that gap is explicitly
 *     deferred to Phase 12.5 ("full enable/disable/enable integration test
 *     with OS-level trust store checks"), not this fix. Only a human
 *     running the built `security` commands on a real Mac (or a future
 *     decision to add a `macos-latest` CI job) can confirm the macOS path.
 *     That manual check has not been done.
 *
 * This phase must not be marked Verified until the macOS path has also been
 * confirmed by manual execution on a real Mac — see WORKPLAN.md's Phase
 * 12.1 status note for the fuller accounting.
 */
describe('network/trust-store — Phase 12.1', () => {
  const FAKE_HOME_MAC = '/Users/dev';
  const FAKE_HOME_LINUX = '/home/dev';
  const CERT_PATH = '/tmp/stenod-rootCA.pem';

  describe('buildInstallCommand()', () => {
    it('builds the macOS per-user (login keychain, no admin) install command', () => {
      const result = buildInstallCommand(CERT_PATH, { platform: 'darwin', homeDir: FAKE_HOME_MAC });

      expect(result).toEqual({
        supported: true,
        cmd: 'security',
        args: [
          'add-trusted-cert',
          '-r',
          'trustRoot',
          '-k',
          join(FAKE_HOME_MAC, 'Library', 'Keychains', 'login.keychain-db'),
          CERT_PATH,
        ],
      });

      // Never the System keychain / admin-scoped flag.
      expect(result.supported && result.args).not.toContain('/Library/Keychains/System.keychain');
      expect(result.supported && result.args.join(' ')).not.toContain('-d ');
    });

    it('builds the Linux per-user NSS DB install command', () => {
      const result = buildInstallCommand(CERT_PATH, {
        platform: 'linux',
        homeDir: FAKE_HOME_LINUX,
      });

      expect(result).toEqual({
        supported: true,
        cmd: 'certutil',
        args: [
          '-d',
          `sql:${join(FAKE_HOME_LINUX, '.pki', 'nssdb')}`,
          '-A',
          '-t',
          'C,,',
          '-n',
          ROOT_CA_COMMON_NAME,
          '-i',
          CERT_PATH,
        ],
      });
    });

    it('reports win32 as an explicit unsupported platform, not a silent no-op or error', () => {
      const result = buildInstallCommand(CERT_PATH, {
        platform: 'win32',
        homeDir: 'C:\\Users\\dev',
      });

      expect(result).toEqual({ supported: false, platform: 'win32' });
    });

    it('reports any other non-Linux/Mac platform as unsupported too', () => {
      const result = buildInstallCommand(CERT_PATH, { platform: 'freebsd', homeDir: '/home/dev' });

      expect(result).toEqual({ supported: false, platform: 'freebsd' });
    });
  });

  describe('buildVerifyCommand()', () => {
    it('builds the macOS lookup-by-name command against the login keychain', () => {
      const result = buildVerifyCommand({ platform: 'darwin', homeDir: FAKE_HOME_MAC });

      expect(result).toEqual({
        supported: true,
        cmd: 'security',
        args: [
          'find-certificate',
          '-c',
          ROOT_CA_COMMON_NAME,
          join(FAKE_HOME_MAC, 'Library', 'Keychains', 'login.keychain-db'),
        ],
      });
    });

    it('builds the Linux NSS DB lookup-by-nickname command', () => {
      const result = buildVerifyCommand({ platform: 'linux', homeDir: FAKE_HOME_LINUX });

      expect(result).toEqual({
        supported: true,
        cmd: 'certutil',
        args: [
          '-d',
          `sql:${join(FAKE_HOME_LINUX, '.pki', 'nssdb')}`,
          '-L',
          '-n',
          ROOT_CA_COMMON_NAME,
        ],
      });
    });

    it('reports win32 as unsupported', () => {
      const result = buildVerifyCommand({ platform: 'win32', homeDir: 'C:\\Users\\dev' });

      expect(result).toEqual({ supported: false, platform: 'win32' });
    });
  });

  describe('buildUninstallCommand()', () => {
    it('builds the macOS delete-certificate command against the login keychain', () => {
      const result = buildUninstallCommand({ platform: 'darwin', homeDir: FAKE_HOME_MAC });

      expect(result).toEqual({
        supported: true,
        cmd: 'security',
        args: [
          'delete-certificate',
          '-c',
          ROOT_CA_COMMON_NAME,
          join(FAKE_HOME_MAC, 'Library', 'Keychains', 'login.keychain-db'),
        ],
      });
    });

    it('builds the Linux NSS DB removal command', () => {
      const result = buildUninstallCommand({ platform: 'linux', homeDir: FAKE_HOME_LINUX });

      expect(result).toEqual({
        supported: true,
        cmd: 'certutil',
        args: [
          '-d',
          `sql:${join(FAKE_HOME_LINUX, '.pki', 'nssdb')}`,
          '-D',
          '-n',
          ROOT_CA_COMMON_NAME,
        ],
      });
    });

    it('reports win32 as unsupported', () => {
      const result = buildUninstallCommand({ platform: 'win32', homeDir: 'C:\\Users\\dev' });

      expect(result).toEqual({ supported: false, platform: 'win32' });
    });
  });

  describe('installTrustStore() / verifyTrustStoreInstall() — unsupported-platform behavior', () => {
    it('installTrustStore() throws UnsupportedPlatformError on win32 rather than attempting anything', () => {
      expect(() =>
        installTrustStore(CERT_PATH, { platform: 'win32', homeDir: 'C:\\Users\\dev' })
      ).toThrow(UnsupportedPlatformError);
    });

    it('verifyTrustStoreInstall() throws UnsupportedPlatformError on win32 rather than attempting anything', () => {
      expect(() =>
        verifyTrustStoreInstall({ platform: 'win32', homeDir: 'C:\\Users\\dev' })
      ).toThrow(UnsupportedPlatformError);
    });

    it('uninstallTrustStore() throws UnsupportedPlatformError on win32 rather than attempting anything', () => {
      expect(() =>
        uninstallTrustStore({ platform: 'win32', homeDir: 'C:\\Users\\dev' })
      ).toThrow(UnsupportedPlatformError);
    });

    it('the thrown error names the offending platform and explains the Linux/Mac scope', () => {
      try {
        installTrustStore(CERT_PATH, { platform: 'win32', homeDir: 'C:\\Users\\dev' });
        expect.unreachable('installTrustStore should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedPlatformError);
        expect((err as InstanceType<typeof UnsupportedPlatformError>).platform).toBe('win32');
        expect((err as Error).message).toContain('win32');
        expect((err as Error).message).toContain('Linux/Mac');
      }
    });
  });

  // ── Real NSS execution (Linux only) ─────────────────────────────────────
  //
  // Only runs on a genuine Linux host — see the file header for exactly why
  // this is gated on `process.platform === 'linux'` rather than a PATH
  // probe. Everywhere else (including this project's own Windows dev
  // machines), `describe.runIf` skips this block visibly rather than
  // silently omitting it.
  describe.runIf(process.platform === 'linux')(
    'installTrustStore() / verifyTrustStoreInstall() — real NSS execution',
    () => {
      let scratchHome: string;
      let nssDbDir: string;

      beforeEach(() => {
        // A throwaway home directory, never the real developer/CI-runner
        // home — installTrustStore()/verifyTrustStoreInstall() only ever
        // touch `<homeDir>/.pki/nssdb`, so pointing homeDir here keeps this
        // test fully isolated from any real trust store.
        scratchHome = mkdtempSync(join(tmpdir(), 'stenod-trust-store-test-'));
        nssDbDir = join(scratchHome, '.pki', 'nssdb');
        mkdirSync(nssDbDir, { recursive: true });

        // Real NSS DB, initialized empty. `--empty-password` matches the
        // no-prompt, per-user convenience store installTrustStore() assumes
        // — there is no password-entry step anywhere in its own command
        // construction, so the DB it operates on must accept that.
        const init = spawnSync('certutil', ['-N', '-d', `sql:${nssDbDir}`, '--empty-password'], {
          encoding: 'utf8',
        });
        if (init.status !== 0) {
          throw new Error(`failed to initialize scratch NSS DB: ${init.stderr || init.error}`);
        }
      });

      afterEach(() => {
        // Runs even if the test body threw/failed — the scratch DB is
        // never left behind on disk.
        if (scratchHome) {
          rmSync(scratchHome, { recursive: true, force: true });
        }
      });

      it('installs the generated CA into a scratch NSS DB and confirms it via a real certutil query', () => {
        const { certPem } = generateRootCa();
        const certPath = join(scratchHome, 'rootCA.pem');
        writeFileSync(certPath, certPem, 'utf8');

        // Confirms the scratch DB genuinely starts clean — the CA is not
        // yet present, so the "after" assertion below is proving a real
        // state change, not a command that would report success regardless.
        const before = verifyTrustStoreInstall({ platform: 'linux', homeDir: scratchHome });
        expect(before.success).toBe(false);

        const installed = installTrustStore(certPath, { platform: 'linux', homeDir: scratchHome });
        expect(installed.success).toBe(true);

        const after = verifyTrustStoreInstall({ platform: 'linux', homeDir: scratchHome });
        expect(after.success).toBe(true);
        expect(after.stdout).toContain(ROOT_CA_COMMON_NAME);
      });

      it('uninstalls a previously installed CA from the scratch NSS DB and confirms removal via certutil query', () => {
        const { certPem } = generateRootCa();
        const certPath = join(scratchHome, 'rootCA.pem');
        writeFileSync(certPath, certPem, 'utf8');

        // Install it
        const installed = installTrustStore(certPath, { platform: 'linux', homeDir: scratchHome });
        expect(installed.success).toBe(true);

        // Verify it is there
        const beforeUninstall = verifyTrustStoreInstall({ platform: 'linux', homeDir: scratchHome });
        expect(beforeUninstall.success).toBe(true);

        // Uninstall it
        const uninstalled = uninstallTrustStore({ platform: 'linux', homeDir: scratchHome });
        expect(uninstalled.success).toBe(true);

        // Verify it is gone
        const afterUninstall = verifyTrustStoreInstall({ platform: 'linux', homeDir: scratchHome });
        expect(afterUninstall.success).toBe(false);
      });

      it('does not affect the real per-user NSS DB — a second scratch DB is unaffected by the first install', () => {
        // Guards against a regression where homeDir gets ignored and the
        // code falls back to the real ~/.pki/nssdb.
        const { certPem } = generateRootCa();
        const certPath = join(scratchHome, 'rootCA.pem');
        writeFileSync(certPath, certPem, 'utf8');
        installTrustStore(certPath, { platform: 'linux', homeDir: scratchHome });

        const otherScratchHome = mkdtempSync(join(tmpdir(), 'stenod-trust-store-test-other-'));
        try {
          const otherNssDbDir = join(otherScratchHome, '.pki', 'nssdb');
          mkdirSync(otherNssDbDir, { recursive: true });
          const initOther = spawnSync(
            'certutil',
            ['-N', '-d', `sql:${otherNssDbDir}`, '--empty-password'],
            { encoding: 'utf8' }
          );
          expect(initOther.status).toBe(0);

          const lookupInOtherDb = verifyTrustStoreInstall({
            platform: 'linux',
            homeDir: otherScratchHome,
          });
          expect(lookupInOtherDb.success).toBe(false);
        } finally {
          rmSync(otherScratchHome, { recursive: true, force: true });
        }
      });
    }
  );
});
