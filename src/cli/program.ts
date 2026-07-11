import { existsSync, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { stenodInit } from '../daemon/init.js';
import { startDaemon, stopDaemon } from '../daemon/lifecycle.js';
import { getDaemonStatus } from '../daemon/status.js';
import { WorkspaceLockedError, pidLockPath, stenoDir } from '../workspace/sandbox.js';
import { openDatabase, runMigrations } from '../storage/index.js';
import type { ManifestOutcome } from '../storage/index.js';
import { compileManifest } from '../compiler/index.js';
import { copyManifestToClipboard, writeManifestLogEntry, tagManifestOutcome } from '../delivery/index.js';
import { deriveCurrentFsmState, deriveUnresolvedErrorContext } from './handoff-context.js';
import { rejectSince } from '../lifecycle/index.js';
import { anchorConstraint } from './anchor.js';
import { runMcpServer } from '../mcp/index.js';
import {
  enableNetworkCapture,
  stopNetworkCapture,
  PROVIDER_ALLOWLIST,
  UnsupportedPlatformError,
} from '../network/index.js';
import type { NetworkCaptureHandle } from '../network/index.js';
/**
 * Polls until the Phase 2.1 PID lock file at `lockPath` disappears (i.e. the
 * daemon that owned it has released it via `detachWorkspace()` inside
 * `stopDaemon()`), or returns false after `timeoutMs`. Mirrors the
 * debounce-free polling style `waitForQueueDrain` already uses in
 * `daemon/lifecycle.ts` for the same class of "wait for an external process
 * to finish" problem.
 */
async function waitForLockRemoval(lockPath: string, timeoutMs = 5000, pollIntervalMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!existsSync(lockPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return !existsSync(lockPath);
}

/**
 * Neither SSOT nor WORKPLAN defines a default token budget anywhere —
 * `compileManifest()` (Phase 8.9) requires one as a plain positional
 * argument with no built-in default. Per explicit user decision: a fixed,
 * documented constant here, overridable via `--token-budget`.
 */
const DEFAULT_TOKEN_BUDGET = 8000;

/**
 * The literal recency-zone "resume instruction" text (SSOT §6.4). Neither
 * SSOT nor WORKPLAN defines what this text should say — Phase 8.6's own
 * header comment explicitly declines to invent one ("this phase therefore
 * takes resumeInstruction as an opaque, caller-supplied string rather than
 * inventing how to generate it"). Per explicit user decision: a fixed,
 * generic template rather than deriving anything content-specific.
 */
const RESUME_INSTRUCTION = 'Resume this coding session using the causal history above.';

export const program = new Command();

program
  .name('stenod')
  .description('Local, deterministic, out-of-band session capture daemon for AI-assisted coding.')
  .version('0.1.0');

program
  .command('init')
  .description('Set up daemon + DB for a project directory, generate local auth token, install systemd/launchd unit')
  .option('--reset', 'Rotate the local auth token')
  .action((options: { reset?: boolean }) => {
    try {
      const result = stenodInit(process.cwd(), { reset: options.reset ?? false });

      console.log(`Initialized Stenod workspace at ${result.projectRoot}`);
      console.log(`  Sandbox: ${result.stenoDir}`);
      console.log(`  Token: ${options.reset ? 'rotated' : 'ready'} (${result.tokenPath})`);
      if (result.serviceUnitPath) {
        console.log(`  Service unit: ${result.serviceUnitPath}`);
      } else {
        console.log(`  Service unit: none (unsupported platform "${result.platform}")`);
      }
    } catch (err) {
      if (err instanceof WorkspaceLockedError) {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

program
  .command('start')
  .description('Start the ingestion daemon (default tier: filesystem + terminal)')
  .option(
    '--project-root <path>',
    'Project root directory (defaults to the current working directory) — matches the ' +
      '--project-root flag the generated systemd/launchd unit (Phase 7.1) invokes this with'
  )
  .option('--foreground', 'Run in foreground (used internally by the detached daemon)')
  .action((options: { projectRoot?: string; foreground?: boolean }) => {
    const root = options.projectRoot ?? process.cwd();

    try {
      if (!options.foreground) {
        const status = getDaemonStatus(root);
        if (status.running && status.pid !== undefined) {
          throw new WorkspaceLockedError(resolve(root), status.pid);
        }

        // Captured to disk (not `stdio: 'ignore'`) so a background daemon
        // that crashes or misbehaves after detaching is debuggable from
        // its own log files, rather than requiring manual reproduction —
        // exactly the gap that made diagnosing Phase 10.7's E2E flake slow.
        // Truncated ('w') on each start so the logs always reflect the
        // most recent run, not an ever-growing history across restarts.
        mkdirSync(stenoDir(root), { recursive: true });
        const outLogPath = join(stenoDir(root), 'daemon-out.log');
        const errLogPath = join(stenoDir(root), 'daemon-err.log');
        const outLog = openSync(outLogPath, 'w');
        const errLog = openSync(errLogPath, 'w');

        const child = spawn(process.execPath, [process.argv[1], 'start', '--foreground', '--project-root', root], {
          detached: true,
          stdio: ['ignore', outLog, errLog],
          cwd: process.cwd(),
        });
        child.unref();
        console.log(`stenod daemon starting in background for ${root}`);
        console.log(`  Logs: ${outLogPath} / ${errLogPath}`);
        return;
      }

      const handle = startDaemon(root);

      console.log(`stenod daemon started for ${handle.projectRoot} (PID ${process.pid})`);
      console.log('Press Ctrl+C to stop, or run `stenod stop` from another terminal on this project.');

      let shuttingDown = false;
      const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        try {
          await stopDaemon(handle);
          console.log('stenod daemon stopped.');
          process.exit(0);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err) {
      if (err instanceof WorkspaceLockedError) {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

program
  .command('stop')
  .description('Stop the daemon')
  .action(async () => {
    const root = process.cwd();
    const status = getDaemonStatus(root);

    if (!status.running || status.pid === undefined) {
      console.log(`stenod: no daemon running for ${root}`);
      return;
    }

    process.kill(status.pid, 'SIGTERM');
    const stopped = await waitForLockRemoval(pidLockPath(root));

    if (stopped) {
      console.log(`stenod daemon stopped (PID ${status.pid}).`);
    } else {
      console.error(`stenod: timed out waiting for daemon (PID ${status.pid}) to stop.`);
      process.exitCode = 1;
    }
  });

program
  .command('status')
  .description('Daemon health, node count, last event timestamp')
  .action(() => {
    const root = process.cwd();
    const status = getDaemonStatus(root);

    console.log(`Project root: ${root}`);
    console.log(`Running: ${status.running}${status.pid !== undefined ? ` (PID ${status.pid})` : ''}`);
    console.log(`Node count: ${status.nodeCount}`);
    console.log(
      `Last event: ${status.lastEventAt !== undefined ? new Date(status.lastEventAt).toISOString() : 'never'}`
    );
  });

program
  .command('handoff')
  .description('Compile and copy the Handoff Manifest to clipboard')
  .option('--worked', 'Tag the outcome of the most recent manifest in the audit log as worked')
  .option('--failed', 'Tag the outcome of the most recent manifest in the audit log as failed')
  .option('--token-budget <n>', `Token budget for the compiled manifest (default: ${DEFAULT_TOKEN_BUDGET})`)
  .action(async (options: { worked?: boolean; failed?: boolean; tokenBudget?: string }) => {
    if (options.worked && options.failed) {
      console.error('stenod: cannot specify both --worked and --failed');
      process.exitCode = 1;
      return;
    }

    const root = process.cwd();
    if (!existsSync(stenoDir(root))) {
      console.error(`stenod: no Stenod workspace found at ${root} — run \`stenod init\` first.`);
      process.exitCode = 1;
      return;
    }

    const db = openDatabase(join(stenoDir(root), 'graph.db'));
    try {
      runMigrations(db);

      if (options.worked || options.failed) {
        const outcome: ManifestOutcome = options.worked ? 'WORKED' : 'FAILED';
        const result = tagManifestOutcome(db, outcome);
        if (result.updated) {
          console.log(`Tagged most recent manifest (${result.id}) as ${outcome}.`);
        } else {
          console.log('stenod: no manifest_log entries to tag yet — run `stenod handoff` first.');
        }
        return;
      }

      let tokenBudget = DEFAULT_TOKEN_BUDGET;
      if (options.tokenBudget !== undefined) {
        const parsed = Number(options.tokenBudget);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          console.error(`stenod: --token-budget must be a positive integer (got "${options.tokenBudget}")`);
          process.exitCode = 1;
          return;
        }
        tokenBudget = parsed;
      }

      const fsmState = deriveCurrentFsmState(db);
      const unresolvedErrorContext =
        fsmState === 'RUNTIME_ERR' ? deriveUnresolvedErrorContext(db) : undefined;

      const manifest = compileManifest(db, tokenBudget, {
        resumeInstruction: RESUME_INSTRUCTION,
        fsmState,
        unresolvedErrorContext,
      });

      writeManifestLogEntry(db, manifest);
      await copyManifestToClipboard(manifest);

      const nodeCount = manifest.primacyZone.length + manifest.middleZone.length;
      console.log(
        `Handoff Manifest copied to clipboard (${nodeCount} node${nodeCount === 1 ? '' : 's'}, ${tokenBudget}-token budget).`
      );
    } finally {
      db.close();
    }
  });

program
  .command('mcp')
  .description('Run as an MCP server over stdio to expose the handoff resource')
  .action(async () => {
    try {
      await runMcpServer();
    } catch (err) {
      if (err instanceof Error) {
        console.error(err.message);
      } else {
        console.error(String(err));
      }
      process.exitCode = 1;
    }
  });

program
  .command('reject')
  .description('Mark nodes in a time window as REJECTED, excluded from all future manifests')
  .requiredOption('--since <duration>', 'Time window to reject')
  .action((options: { since: string }) => {
    const root = process.cwd();
    if (!existsSync(stenoDir(root))) {
      console.error(`stenod: no Stenod workspace found at ${root} — run \`stenod init\` first.`);
      process.exitCode = 1;
      return;
    }

    const db = openDatabase(join(stenoDir(root), 'graph.db'));
    try {
      runMigrations(db);
      const count = rejectSince(db, options.since);
      console.log(`Rejected ${count} node${count === 1 ? '' : 's'} created within the last ${options.since}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });

program
  .command('anchor <text>')
  .description('Create a CONSTRAINT node directly from the CLI')
  .action((text: string) => {
    const root = process.cwd();
    if (!existsSync(stenoDir(root))) {
      console.error(`stenod: no Stenod workspace found at ${root} — run \`stenod init\` first.`);
      process.exitCode = 1;
      return;
    }

    const db = openDatabase(join(stenoDir(root), 'graph.db'));
    try {
      runMigrations(db);
      const result = anchorConstraint(db, text);

      if (!result.created) {
        console.log(`stenod: identical constraint already anchored (${result.id}) — no change.`);
        return;
      }

      console.log(`Anchored CONSTRAINT node ${result.id}.`);
      if (result.constraintKey) {
        console.log(`  Key: ${result.constraintKey}`);
        if (result.lww && result.lww.supersededCount > 0) {
          console.log(`  Superseded ${result.lww.supersededCount} prior constraint(s) sharing this key.`);
        }
      } else {
        console.log('  No key detected (use "key=value" text to enable conflict resolution).');
      }
    } finally {
      db.close();
    }
  });

program
  .command('enable-network-capture')
  .description('Opt in to the AI-provider network capture tier (installs local CA, starts proxy)')
  .action(async () => {
    const root = process.cwd();
    if (!existsSync(stenoDir(root))) {
      console.error(`stenod: no Stenod workspace found at ${root} — run \`stenod init\` first.`);
      process.exitCode = 1;
      return;
    }

    console.log('stenod: enabling the opt-in AI-provider network capture tier. This will:');
    console.log('  1. Generate a local root CA and install it into your OS trust store');
    console.log('     (per-user only — no admin/sudo, no System-wide trust).');
    console.log('  2. Start a local HTTPS proxy that intercepts traffic to known AI-provider');
    console.log(`     domains only (${PROVIDER_ALLOWLIST.join(', ')}) — everything else passes`);
    console.log('     through untouched and unlogged.');
    console.log("  3. Record captured AI-provider responses into this project's causal graph.");
    console.log('This installs a certificate your system will trust — a real trust decision.');
    console.log('Run `stenod disable-network-capture` at any time to fully revert it.');
    console.log('');

    let handle: NetworkCaptureHandle;
    try {
      handle = await enableNetworkCapture(root);
    } catch (err) {
      if (err instanceof UnsupportedPlatformError) {
        console.error(err.message);
      } else if (err instanceof Error) {
        console.error(err.message);
      } else {
        console.error(String(err));
      }
      process.exitCode = 1;
      return;
    }

    console.log(`Root CA installed at: ${handle.ca.certPath}`);
    console.log(
      `Trust store install: ${handle.trustStoreResult.success ? 'succeeded' : 'FAILED'} ` +
        `(platform: ${handle.trustStoreResult.platform}).`
    );
    if (!handle.trustStoreResult.success) {
      console.error(
        'stenod: trust store install failed — TLS clients will likely reject this CA. ' +
          (handle.trustStoreResult.stderr || '(no stderr output)')
      );
    }
    console.log(`Proxy listening at: ${handle.proxy.server.url}`);
    console.log('Point your shell/AI tool at the proxy by setting:');
    console.log(`  HTTP_PROXY=${handle.proxy.server.url}`);
    console.log(`  HTTPS_PROXY=${handle.proxy.server.url}`);
    console.log('Press Ctrl+C to stop capturing.');

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await stopNetworkCapture(handle);
        console.log('stenod: network capture stopped.');
        process.exit(0);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('disable-network-capture')
  .description('Fully revert the CA trust and proxy settings')
  .action(() => {
    console.log('Not yet implemented');
  });
