import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { stenodInit } from '../daemon/init.js';
import { startDaemon, stopDaemon } from '../daemon/lifecycle.js';
import { getDaemonStatus } from '../daemon/status.js';
import { WorkspaceLockedError, pidLockPath } from '../workspace/sandbox.js';

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

        const child = spawn(process.execPath, [process.argv[1], 'start', '--foreground', '--project-root', root], {
          detached: true,
          stdio: 'ignore',
          cwd: process.cwd(),
        });
        child.unref();
        console.log(`stenod daemon starting in background for ${root}`);
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
  .action((_options) => {
    console.log('Not yet implemented');
  });

program
  .command('reject')
  .description('Mark nodes in a time window as REJECTED, excluded from all future manifests')
  .requiredOption('--since <duration>', 'Time window to reject')
  .action((_options) => {
    console.log('Not yet implemented');
  });

program
  .command('anchor <text>')
  .description('Create a CONSTRAINT node directly from the CLI')
  .action((_text) => {
    console.log('Not yet implemented');
  });

program
  .command('enable-network-capture')
  .description('Opt in to the AI-provider network capture tier (installs local CA, starts proxy)')
  .action(() => {
    console.log('Not yet implemented');
  });

program
  .command('disable-network-capture')
  .description('Fully revert the CA trust and proxy settings')
  .action(() => {
    console.log('Not yet implemented');
  });
