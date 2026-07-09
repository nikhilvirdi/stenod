import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachWorkspace, detachWorkspace, stenoDir } from '../workspace/sandbox.js';
import { initToken, tokenPath } from '../workspace/token.js';

/**
 * Phase 7.1 — `stenod init`
 *
 * SSOT §5: "stenod init | Set up daemon + DB for a project directory,
 * generate local auth token, install systemd/launchd unit."
 * SSOT §6.1: "Daemon crash recovery: `stenod init` generates a systemd
 * user unit (Linux) or launchd plist (Mac) with `Restart=on-failure`."
 *
 * Composes already-Verified Phase 2.1 (workspace sandboxing) and Phase 2.2
 * (auth token) exactly as WORKPLAN's Build line describes ("runs workspace
 * sandboxing (2.1), token generation (2.2)") — neither is reimplemented
 * here, both are imported and called as-is. The only genuinely new logic
 * in this phase is generating the systemd/launchd service unit content.
 *
 * Scope note — Do NOT (per WORKPLAN): this does not wire into the CLI
 * (Milestone 10) or make `stenod init` an actual runnable command; it is
 * the underlying function Milestone 10 will later call.
 *
 * Design decisions (documented for review, since neither is spelled out
 * verbatim in STENOD_SSOT.md or WORKPLAN.md):
 * -----------------------------------------------------------------------
 * - `attachWorkspace()` (2.1) acquires a PID lock file tied to the calling
 *   process. `stenod init` is a one-shot setup command, not the persistent
 *   daemon process itself — that PID lock belongs to `stenod start`
 *   (Phase 7.2), run later, possibly by a different process entirely. So
 *   init calls `attachWorkspace()` (which is what actually creates
 *   `.stenod/`, and doubles as a check that a live daemon isn't already
 *   running against this root) and then immediately `detachWorkspace()`,
 *   leaving `.stenod/` in place without a dangling lock file that would
 *   otherwise reference an already-exited init process.
 * - The generated unit file is written to `.stenod/` (e.g.
 *   `.stenod/stenod.service`), not to the real OS service directories
 *   (`~/.config/systemd/user/`, `~/Library/LaunchAgents/`). Actually
 *   registering a service is a real, hard-to-reverse system-level side
 *   effect — CLAUDE.md's "never trigger CA install or proxy setup from
 *   init or start" establishes the same caution for this project's `init`
 *   generally. Writing the artifact into the project's own sandbox is
 *   consistent with "build and test the underlying function directly"
 *   (the "Do NOT" line) and leaves actual OS installation to a later,
 *   explicit step once Milestone 10 wires up the CLI.
 * - `ExecStart`/`ProgramArguments` reference the `stenod` command name
 *   (this package's own `name` in package.json) rather than a concrete
 *   file path, since no CLI binary exists yet (Milestone 10). The unit
 *   file's job right now is to be syntactically valid and structurally
 *   correct; it becomes actually executable once the CLI ships.
 * - `platform` is an injectable option (defaulting to `process.platform`)
 *   rather than hardcoded, so both the systemd and launchd generation
 *   paths are deterministically testable from a single host OS — the same
 *   pattern already used for platform branching in `workspace/ipc.ts` and
 *   its tests.
 * - Platforms other than `linux`/`darwin` (SSOT only specifies these two)
 *   produce no service unit artifact; `.stenod/` and the token are still
 *   created. This mirrors Phase 5.1's precedent of Windows being
 *   explicitly out of scope for daemon-process concerns, rather than
 *   failing `init` entirely on an unsupported OS.
 */

export interface StenodInitOptions {
  /** Forces token rotation (the `stenod init --reset` path). Defaults to false. */
  reset?: boolean;
  /** Overrides the detected platform, for deterministic cross-platform testing. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

export interface StenodInitResult {
  projectRoot: string;
  stenoDir: string;
  token: string;
  tokenPath: string;
  /** Absolute path of the generated service unit file, or undefined on unsupported platforms. */
  serviceUnitPath: string | undefined;
  /** Content of the generated service unit file, or undefined on unsupported platforms. */
  serviceUnitContent: string | undefined;
  platform: NodeJS.Platform;
}

/** Escapes the five reserved XML characters for safe use inside plist text/attribute content. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Builds a systemd user unit (INI format) with `Restart=on-failure`, per SSOT §6.1. */
function buildSystemdUnit(projectRoot: string): string {
  return `[Unit]
Description=Stenod capture daemon for ${projectRoot}

[Service]
Type=simple
ExecStart=stenod start --project-root "${projectRoot}"
WorkingDirectory=${projectRoot}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * Builds a launchd plist (XML) equivalent to `Restart=on-failure`: launchd
 * has no direct "on-failure" flag, but `KeepAlive.SuccessfulExit=false`
 * means "restart only when the last exit was NOT successful" — the same
 * semantics.
 */
function buildLaunchdPlist(projectRoot: string): string {
  const escapedRoot = escapeXml(projectRoot);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.stenod.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>stenod</string>
    <string>start</string>
    <string>--project-root</string>
    <string>${escapedRoot}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapedRoot}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
`;
}

/**
 * Sets up a project directory for Stenod: workspace sandbox (`.stenod/`),
 * local auth token, and (on Linux/Mac) a crash-recovery service unit
 * artifact. Idempotent for the token unless `options.reset` is set (the
 * `stenod init --reset` rotation path); safe to re-run.
 */
export function stenodInit(projectRoot: string, options: StenodInitOptions = {}): StenodInitResult {
  const platform = options.platform ?? process.platform;

  const resolvedRoot = attachWorkspace(projectRoot);
  detachWorkspace(resolvedRoot);

  const token = initToken(resolvedRoot, options.reset ?? false);

  let serviceUnitPath: string | undefined;
  let serviceUnitContent: string | undefined;

  if (platform === 'linux') {
    serviceUnitContent = buildSystemdUnit(resolvedRoot);
    serviceUnitPath = join(stenoDir(resolvedRoot), 'stenod.service');
    writeFileSync(serviceUnitPath, serviceUnitContent, 'utf8');
  } else if (platform === 'darwin') {
    serviceUnitContent = buildLaunchdPlist(resolvedRoot);
    serviceUnitPath = join(stenoDir(resolvedRoot), 'com.stenod.daemon.plist');
    writeFileSync(serviceUnitPath, serviceUnitContent, 'utf8');
  }

  return {
    projectRoot: resolvedRoot,
    stenoDir: stenoDir(resolvedRoot),
    token,
    tokenPath: tokenPath(resolvedRoot),
    serviceUnitPath,
    serviceUnitContent,
    platform,
  };
}
