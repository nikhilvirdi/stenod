import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  buildInstallCommand,
  buildVerifyCommand,
  installTrustStore,
  verifyTrustStoreInstall,
  UnsupportedPlatformError,
} from './trust-store.js';
import { ROOT_CA_COMMON_NAME } from './ca.js';

/**
 * Phase 12.1 — Trust Store Command Tests
 *
 * WORKPLAN "Done when" checklist item under test:
 *   [ ] Trust store installation confirmed via OS-level check
 *
 * VERIFICATION GAP (documented, not hidden — read this before trusting the
 * green checkmark on this file): every test below exercises command
 * *construction* deterministically (platform and homeDir are both injected
 * — see trust-store.ts's design note) and confirms `win32` is treated as an
 * explicit unsupported platform, matching the `daemon/init.ts` precedent.
 * NOT ONE test here actually shells out to a real `security`/`certutil`
 * binary or touches a live OS trust store, on any platform. That real
 * execution gap splits into two structurally different cases:
 *
 *   - LINUX: genuinely closeable by this project's own CI. `.github/
 *     workflows/ci.yml` runs on `ubuntu-latest`, whose runner image ships
 *     `libnss3-tools` (i.e. `certutil`) preinstalled — a real
 *     `installTrustStore`/`verifyTrustStoreInstall` round-trip against a
 *     scratch NSS DB could execute for real in that pipeline today, no
 *     extra setup needed. No such test exists yet in this file. WORKPLAN's
 *     own Phase 12.1 "Verify" line calls for "manual OS trust store
 *     inspection" rather than CI automation at this stage; a real automated
 *     OS-level round-trip is Phase 12.5's stated mandate ("full
 *     enable/disable/enable integration test with OS-level trust store
 *     checks"), not this phase's.
 *
 *   - MACOS: NOT closeable by this project's CI, ever, under the current
 *     pipeline — `ci.yml` runs `ubuntu-latest` only, by deliberate design
 *     (its own header comment: a macOS/Windows matrix "would be misleading
 *     about what is actually portable today"). No amount of test-writing
 *     changes this; only a human running the built `security` commands on
 *     a real Mac (or a future decision to add a `macos-latest` CI job) can
 *     confirm the macOS path actually works. That manual check has not
 *     been done.
 *
 * This phase must not be marked Verified until at least the Linux path has
 * been confirmed by real execution (CI or a manual Linux host) and the
 * macOS path has been confirmed by manual execution on a real Mac — see
 * WORKPLAN.md's Phase 12.1 status note for the fuller accounting.
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
});
