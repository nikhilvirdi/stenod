import { Command } from 'commander';

export const program = new Command();

program
  .name('stenod')
  .description('Local, deterministic, out-of-band session capture daemon for AI-assisted coding.')
  .version('0.1.0');

program
  .command('init')
  .description('Set up daemon + DB for a project directory, generate local auth token, install systemd/launchd unit')
  .action(() => {
    console.log('Not yet implemented');
  });

program
  .command('start')
  .description('Start the ingestion daemon (default tier: filesystem + terminal)')
  .action(() => {
    console.log('Not yet implemented');
  });

program
  .command('stop')
  .description('Stop the daemon')
  .action(() => {
    console.log('Not yet implemented');
  });

program
  .command('status')
  .description('Daemon health, node count, last event timestamp')
  .action(() => {
    console.log('Not yet implemented');
  });

program
  .command('handoff')
  .description('Compile and copy the Handoff Manifest to clipboard')
  .option('--worked', 'Tag the outcome of the most recent manifest in the audit log as worked')
  .option('--failed', 'Tag the outcome of the most recent manifest in the audit log as failed')
  .action((options) => {
    console.log('Not yet implemented');
  });

program
  .command('reject')
  .description('Mark nodes in a time window as REJECTED, excluded from all future manifests')
  .requiredOption('--since <duration>', 'Time window to reject')
  .action((options) => {
    console.log('Not yet implemented');
  });

program
  .command('anchor <text>')
  .description('Create a CONSTRAINT node directly from the CLI')
  .action((text) => {
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
