import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT_CA_COMMON_NAME } from './ca.js';

/**
 * Phase 12.1 — Trust Store Install
 *
 * SSOT §6.1 (opt-in tier):
 *   "Generates a local root CA, installed into the OS trust store only when
 *    this command is explicitly run — never silently."
 *
 * Per the phase's user-approved decisions:
 *   - Platform scope: Linux + macOS only, matching SSOT §9 ("Full Windows
 *     ConPTY validation (Unix/Mac only for now)") and the precedent already
 *     set by `daemon/init.ts`, which treats Windows as an unsupported no-op
 *     rather than an error. `win32` (and any other platform) is an explicit,
 *     labeled unsupported case here — never a silent failure.
 *   - Trust-store scope: per-user, no admin/sudo — the macOS *login*
 *     keychain (not the System keychain) and a per-user NSS database on
 *     Linux (`~/.pki/nssdb`, the same location `certutil`/mkcert-style tools
 *     use for a user's personal trust store). This keeps the install
 *     reversible without elevated privileges, matching SSOT's "opt-in, never
 *     silently, with an equally clear undo path" ethos.
 *
 * DESIGN: command construction is split from execution (mirrors the
 * injectable-`platform` pattern already used in `daemon/init.ts` and
 * `workspace/ipc.ts`'s `socketPath()`), so the exact argv built for each
 * platform is deterministically unit-testable without actually shelling out
 * or touching a real trust store. `homeDir` is likewise injectable so tests
 * don't depend on the host machine's actual home directory.
 *
 * This module does NOT install anything on import, does NOT get called from
 * `stenod init`/`start`, and is NOT wired into `enable-network-capture` yet
 * (Phase 12.4). It exists as a standalone, explicitly-invoked capability.
 *
 * Phase 12.5 addition — `buildUninstallCommand()`/`uninstallTrustStore()`:
 * this phase (12.1) originally shipped install + verify only; Phase 12.5
 * ("Wire `stenod disable-network-capture`") needs a real removal
 * counterpart to fully revert what `installTrustStore()` does, and the only
 * correct way to build a matching removal command is to reuse this file's
 * own `linuxNssDbArg()`/`macLoginKeychainPath()` path-resolution helpers —
 * duplicating that logic in a separate file would create two independently
 * maintained sources of truth for "where the trust store lives." Confirmed
 * with the user before extending this already-Verified phase's file, per
 * the project's regression-guard rule (this addition reverts Phase 12.1 to
 * `Built (unverified)` pending re-verification alongside 12.5 — see
 * WORKPLAN.md's status table).
 */

export interface TrustStoreOptions {
  /** Overrides the detected platform, for deterministic cross-platform testing. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Overrides the resolved home directory, for deterministic testing. Defaults to `os.homedir()`. */
  homeDir?: string;
}

/** A constructed, not-yet-executed OS command. */
export interface SupportedTrustStoreCommand {
  supported: true;
  cmd: string;
  args: string[];
}

/** Returned instead of a command when the platform isn't Linux/Mac. */
export interface UnsupportedTrustStoreCommand {
  supported: false;
  platform: NodeJS.Platform;
}

export type TrustStoreCommand = SupportedTrustStoreCommand | UnsupportedTrustStoreCommand;

/** The per-user NSS database `certutil` reads/writes on Linux, mirroring mkcert's convention. */
function linuxNssDbArg(homeDir: string): string {
  return `sql:${join(homeDir, '.pki', 'nssdb')}`;
}

/** The macOS *login* (per-user) keychain — deliberately not the System keychain, so no admin/sudo is required. */
function macLoginKeychainPath(homeDir: string): string {
  return join(homeDir, 'Library', 'Keychains', 'login.keychain-db');
}

function resolveOptions(options: TrustStoreOptions): {
  platform: NodeJS.Platform;
  homeDir: string;
} {
  return {
    platform: options.platform ?? process.platform,
    homeDir: options.homeDir ?? homedir(),
  };
}

/**
 * Builds the command that installs `certPath` into the per-user trust store.
 *
 * - macOS: `security add-trusted-cert -r trustRoot -k <login keychain> <certPath>`
 *   — trusts the cert for all policies (`-r trustRoot`) in the *login*
 *   keychain, so no `-d`/System-keychain flag and no admin prompt.
 * - Linux: `certutil -d sql:<home>/.pki/nssdb -A -t "C,," -n <nickname> -i <certPath>`
 *   — adds (`-A`) the cert to the per-user NSS DB with CA trust for SSL
 *   (`C,,`), the same mechanism Firefox/Chrome-on-Linux and tools like
 *   mkcert use for a user-level trust store.
 * - Anything else (including `win32`): `{ supported: false }`.
 */
export function buildInstallCommand(
  certPath: string,
  options: TrustStoreOptions = {}
): TrustStoreCommand {
  const { platform, homeDir } = resolveOptions(options);

  if (platform === 'darwin') {
    return {
      supported: true,
      cmd: 'security',
      args: ['add-trusted-cert', '-r', 'trustRoot', '-k', macLoginKeychainPath(homeDir), certPath],
    };
  }

  if (platform === 'linux') {
    return {
      supported: true,
      cmd: 'certutil',
      args: [
        '-d',
        linuxNssDbArg(homeDir),
        '-A',
        '-t',
        'C,,',
        '-n',
        ROOT_CA_COMMON_NAME,
        '-i',
        certPath,
      ],
    };
  }

  return { supported: false, platform };
}

/**
 * Builds the command that queries the trust store for the installed cert —
 * the OS-level check that proves `buildInstallCommand`'s result actually
 * took effect.
 *
 * - macOS: `security find-certificate -c "Stenod Local CA" <login keychain>`.
 * - Linux: `certutil -d sql:<home>/.pki/nssdb -L -n <nickname>`.
 * - Anything else: `{ supported: false }`.
 */
export function buildVerifyCommand(options: TrustStoreOptions = {}): TrustStoreCommand {
  const { platform, homeDir } = resolveOptions(options);

  if (platform === 'darwin') {
    return {
      supported: true,
      cmd: 'security',
      args: ['find-certificate', '-c', ROOT_CA_COMMON_NAME, macLoginKeychainPath(homeDir)],
    };
  }

  if (platform === 'linux') {
    return {
      supported: true,
      cmd: 'certutil',
      args: ['-d', linuxNssDbArg(homeDir), '-L', '-n', ROOT_CA_COMMON_NAME],
    };
  }

  return { supported: false, platform };
}

/**
 * Builds the command that removes a previously-installed cert from the
 * per-user trust store — the inverse of `buildInstallCommand()`. Added in
 * Phase 12.5 ("Wire `stenod disable-network-capture`"), which needs a real
 * removal counterpart to `buildInstallCommand()`/`installTrustStore()` that
 * did not exist when this phase (12.1) originally shipped install/verify
 * only. Reuses the exact same `linuxNssDbArg()`/`macLoginKeychainPath()`
 * path-resolution helpers as the install path, deliberately — one source
 * of truth for "where the trust store lives," not a second, independently
 * maintained copy of that logic.
 *
 * - macOS: `security delete-certificate -c "Stenod Local CA" <login keychain>`
 *   — removes by common name from the same login keychain the cert was
 *   added to. No `-r`/trust-policy flag: `delete-certificate` doesn't take one.
 * - Linux: `certutil -d sql:<home>/.pki/nssdb -D -n <nickname>` — deletes
 *   (`-D`) the cert with this nickname from the same per-user NSS DB.
 * - Anything else (including `win32`): `{ supported: false }`.
 */
export function buildUninstallCommand(options: TrustStoreOptions = {}): TrustStoreCommand {
  const { platform, homeDir } = resolveOptions(options);

  if (platform === 'darwin') {
    return {
      supported: true,
      cmd: 'security',
      args: ['delete-certificate', '-c', ROOT_CA_COMMON_NAME, macLoginKeychainPath(homeDir)],
    };
  }

  if (platform === 'linux') {
    return {
      supported: true,
      cmd: 'certutil',
      args: ['-d', linuxNssDbArg(homeDir), '-D', '-n', ROOT_CA_COMMON_NAME],
    };
  }

  return { supported: false, platform };
}

/** Thrown by `installTrustStore()`/`verifyTrustStoreInstall()` on a platform outside Linux/Mac scope. */
export class UnsupportedPlatformError extends Error {
  constructor(
    public readonly platform: NodeJS.Platform,
    action: string
  ) {
    super(
      `stenod: trust-store ${action} is not supported on platform "${platform}" ` +
        `(Linux/Mac only, per SSOT §9 — Windows trust-store manipulation was ` +
        `explicitly out of scope for this phase).`
    );
    this.name = 'UnsupportedPlatformError';
  }
}

export interface TrustStoreCommandResult {
  /** True iff the underlying OS command exited with status 0. */
  success: boolean;
  platform: NodeJS.Platform;
  stdout: string;
  stderr: string;
}

/**
 * Runs `buildInstallCommand()`'s command, actually installing the cert into
 * the per-user trust store. Throws `UnsupportedPlatformError` on any
 * platform other than Linux/Mac rather than silently no-oping.
 *
 * This is the only function in this module that touches the real OS trust
 * store — it must only ever run when explicitly invoked (this phase does not
 * call it from anywhere; wiring to `enable-network-capture` is Phase 12.4).
 */
export function installTrustStore(
  certPath: string,
  options: TrustStoreOptions = {}
): TrustStoreCommandResult {
  const command = buildInstallCommand(certPath, options);
  if (!command.supported) {
    throw new UnsupportedPlatformError(command.platform, 'installation');
  }

  const result = spawnSync(command.cmd, command.args, { encoding: 'utf8' });
  return {
    success: result.status === 0,
    platform: options.platform ?? process.platform,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Runs `buildVerifyCommand()`'s command, querying the trust store for the
 * installed cert. Throws `UnsupportedPlatformError` on any platform other
 * than Linux/Mac.
 */
export function verifyTrustStoreInstall(options: TrustStoreOptions = {}): TrustStoreCommandResult {
  const command = buildVerifyCommand(options);
  if (!command.supported) {
    throw new UnsupportedPlatformError(command.platform, 'verification');
  }

  const result = spawnSync(command.cmd, command.args, { encoding: 'utf8' });
  return {
    success: result.status === 0,
    platform: options.platform ?? process.platform,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Runs `buildUninstallCommand()`'s command, actually removing the cert from
 * the per-user trust store. Throws `UnsupportedPlatformError` on any
 * platform other than Linux/Mac, matching `installTrustStore()`'s own
 * precedent exactly.
 *
 * Added in Phase 12.5 — see `buildUninstallCommand()`'s header for why.
 */
export function uninstallTrustStore(options: TrustStoreOptions = {}): TrustStoreCommandResult {
  const command = buildUninstallCommand(options);
  if (!command.supported) {
    throw new UnsupportedPlatformError(command.platform, 'removal');
  }

  const result = spawnSync(command.cmd, command.args, { encoding: 'utf8' });
  return {
    success: result.status === 0,
    platform: options.platform ?? process.platform,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
