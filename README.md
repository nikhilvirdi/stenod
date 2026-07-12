# Stenod

Local, deterministic, out-of-band session capture daemon for AI-assisted coding.

Stenod watches your project directory and terminal sessions, recording every file save and shell command into a local causal graph. When you're ready to hand off context to an AI assistant (or switch contexts yourself), Stenod compiles that history into a precise, deterministic prompt covering everything that happened since the last handoff.

> **Zero Telemetry**: Stenod stores everything locally in your project's `.stenod/` directory. It never phones home. See [SECURITY.md](SECURITY.md) for full details on what is captured and how your data is protected.
> 
> See [STENOD_SSOT.md](STENOD_SSOT.md) for the project's single source of truth, architecture, and design decisions.

## Installation

```bash
npm install -g stenod
```

*Note: For local testing before this is published to npm, run `npm run build && npm link` from the repo root, which makes the `stenod` command available globally.*

## Quick Start

Initialize Stenod in your project directory (creates `.stenod/` and generates a local auth token):
```bash
stenod init
```

Start the background ingestion daemon:
```bash
stenod start
```

> [!IMPORTANT]
> `stenod start` alone **only captures filesystem events**. Because the daemon runs fully detached in the background, it has no TTY of its own and cannot automatically attach to your open shells.
> 
> **To capture terminal activity, you must run `stenod attach` separately in each interactive shell you want to capture.**

Attach your current terminal session to the daemon:
```bash
stenod attach
```
This spawns a wrapped shell. When you exit this shell (e.g., via `exit` or Ctrl+D), the accumulated output and exit code will be recorded.

When you're ready to hand off your context to an AI, generate the manifest (copies to your clipboard):
```bash
stenod handoff
```

## Command Reference

### `stenod init`
Set up the daemon and database for a project directory. Generates a local auth token (`.stenod/token`) and creates the `.stenod/` sandbox. On Linux and macOS, it also generates a systemd/launchd service unit file you can install for auto-restart.
- `--reset`: Rotate the local auth token.

### `stenod start`
Start the background ingestion daemon for the project.
- `--project-root <path>`: Specify the project root (defaults to current working directory).
- `--foreground`: Run in the foreground instead of detaching (used internally).

### `stenod stop`
Stop the background ingestion daemon.

### `stenod attach`
Attach an interactive shell to the running daemon. **This must be run explicitly in each shell session you want to capture.**

### `stenod status`
Check daemon health, node count, and the timestamp of the last captured event.

### `stenod handoff`
Compile the causal graph into a Handoff Manifest and copy it to your clipboard.
- `--worked`: Tag the outcome of the most recent manifest in the audit log as having worked successfully.
- `--failed`: Tag the outcome of the most recent manifest in the audit log as having failed.
- `--token-budget <n>`: Override the default token budget (default: 8000).

### `stenod anchor <text>`
Create a CONSTRAINT node directly from the CLI. Use `key=value` text to enable LWW (Last-Writer-Wins) conflict resolution for constraints.

### `stenod reject`
Mark nodes in a time window as REJECTED, excluding them from all future manifests.
- `--since <duration>`: Time window to reject (e.g., `5m`, `1h`). **(Required)**

### `stenod enable-network-capture`
Opt in to the AI-provider network capture tier.
1. Generates a local root CA and installs it into your OS trust store (per-user only).
2. Starts a local HTTPS proxy that intercepts traffic only to known AI-provider domains.
3. Records captured responses into your project's causal graph.

After running this, you must configure your shell/tools to use the printed proxy URL (e.g., `export HTTPS_PROXY=...`).
*Note: This feature is unsupported on Windows.*

### `stenod disable-network-capture`
Fully revert the CA trust and proxy settings. Removes the CA from your OS trust store and deletes the local CA files.

### `stenod mcp`
Run as an MCP (Model Context Protocol) server over stdio to expose the handoff resource directly to compatible AI clients.
