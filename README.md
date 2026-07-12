# Stenod

<img width="1280" height="640" alt="stenod (1)" src="https://github.com/user-attachments/assets/de2bdd63-0cb7-447a-a2cb-f1ac3525748d" />


A black box recorder for your AI coding sessions.

AI-assisted coding sessions collapse at boundaries — rate limits, provider outages, context-window exhaustion, or a developer deliberately switching tools mid-task. What's lost at that moment isn't just chat history; it's the *reasoning*: which decisions were made and why, which approaches were tried and rejected, and what you were mid-way through doing.

Stenod is a local, deterministic daemon that quietly watches your files and terminal — not your chat — and compiles everything that actually matters into a Handoff Manifest the moment you need to resume, in any AI tool, cold. It's out-of-band by design: it never depends on the AI being alive or reachable, because it was never inside that AI in the first place.

[![CI](https://github.com/nikhilvirdi/stenod/actions/workflows/ci.yml/badge.svg)](https://github.com/nikhilvirdi/stenod/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/steno-daemon.svg)](https://www.npmjs.com/package/steno-daemon)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL%20mode-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![better-sqlite3](https://img.shields.io/badge/better--sqlite3-driver-003B57)](https://github.com/WiseLibs/better-sqlite3)
[![Commander.js](https://img.shields.io/badge/CLI-commander.js-black)](https://github.com/tj/commander.js)
[![chokidar](https://img.shields.io/badge/fs%20watching-chokidar-blue)](https://github.com/paulmillr/chokidar)
[![node-pty](https://img.shields.io/badge/terminal-node--pty-blue)](https://github.com/microsoft/node-pty)
[![web-tree-sitter](https://img.shields.io/badge/AST%20parsing-web--tree--sitter-orange)](https://github.com/tree-sitter/tree-sitter)
[![mockttp](https://img.shields.io/badge/HTTPS%20interception-mockttp-purple)](https://github.com/httptoolkit/mockttp)
[![node-forge](https://img.shields.io/badge/CA%20generation-node--forge-purple)](https://github.com/digitalbazaar/forge)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-5A67D8)](https://modelcontextprotocol.io/)
[![Vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![ESLint](https://img.shields.io/badge/lint-ESLint-4B32C3?logo=eslint&logoColor=white)](https://eslint.org/)
[![Prettier](https://img.shields.io/badge/code%20style-Prettier-F7B93E?logo=prettier&logoColor=black)](https://prettier.io/)

For the full architecture, design rationale, and comparison against existing AI-memory tools, see [STENOD_SSOT.md](./STENOD_SSOT.md). For exactly what's captured, where it's stored, and the opt-in network tier's guarantees, see [SECURITY.md](./SECURITY.md).

---

## Install

```
npm install -g steno-daemon
```

The package on npm is named `steno-daemon` (a naming-availability adjustment); the command you run is `stenod`.

## Quick Start

```
stenod init
stenod start
```

> [!IMPORTANT]
> `stenod start` alone only captures **filesystem** events — it never spawns a shell itself, since the daemon runs fully detached. To also capture a **terminal** session, run `stenod attach` in each interactive shell you want captured, once per session.

Work normally — save files, run commands. When you need to hand off:

```
stenod handoff
```

The compiled Handoff Manifest is copied to your clipboard. Paste it into any AI tool to resume exactly where you left off.

## Command Reference

| Command | Description |
|---|---|
| `stenod init [--reset]` | Set up the daemon + database for the current project. `--reset` rotates the local auth token. |
| `stenod start [--project-root <path>] [--foreground]` | Start the ingestion daemon (filesystem capture by default). `--foreground` runs it attached to your terminal instead of detached. |
| `stenod stop` | Stop the daemon cleanly. |
| `stenod status` | Show daemon health, node count, and last event timestamp. |
| `stenod attach` | Bridge the current interactive shell's terminal activity to the daemon. Run once per terminal session you want captured. |
| `stenod handoff [--worked \| --failed] [--token-budget <n>]` | Compile and copy the Handoff Manifest to your clipboard. `--worked`/`--failed` tags the outcome of the most recent manifest. `--token-budget` overrides the default packing budget. |
| `stenod anchor "<text>"` | Create a `CONSTRAINT` node directly — a decision or rule you want the compiler to always include. |
| `stenod reject --since <duration>` | Mark nodes from a time window (e.g. `15m`) as rejected, excluded from all future manifests. |
| `stenod enable-network-capture` | Opt in to capturing AI-provider network traffic (installs a local CA, starts a local proxy). Unix/Mac only. |
| `stenod disable-network-capture` | Fully revert the network-capture tier: removes the CA from the OS trust store, reverts proxy settings. |
| `stenod mcp` | Run as an MCP server over stdio, exposing the handoff manifest as a resource for MCP-connected clients. |

## How It Works

`chokidar` watches your project's files; `stenod attach` bridges real terminal activity in; both feed a causal graph stored in local SQLite, with typed edges (`CAUSED_BY`, `CONTRADICTS`, `DEPENDS_ON`) instead of a vector store — so the system tracks which decisions are *still true*, not just which are *semantically similar*. A deterministic compiler packs the highest-value nodes into a token budget using greedy-by-ratio knapsack packing, structures the output U-shaped (constraints first, causal history in the middle, next steps last) to exploit transformer attention bias, and delivers it via clipboard or, optionally, as an MCP resource.

Full detail: [STENOD_SSOT.md](./STENOD_SSOT.md).

## Security & Privacy

Zero telemetry, always. Local-only storage. The network-capture tier is opt-in, allowlists exactly three known AI-provider domains, and ships with a full, confirmed-clean uninstall path.

Full detail: [SECURITY.md](./SECURITY.md).

## Platform Support

Filesystem capture and the core CLI work on Windows, Linux, and Mac. Terminal capture (`stenod attach`) and the network-capture tier depend on Unix/Mac-only mechanisms (`node-pty`, OS trust-store APIs) and are not available on Windows.

## License & Contributing

MIT © Nikhil Virdi — see [LICENSE](./LICENSE) for details.

This project is not yet accepting external contributions — no `CONTRIBUTING.md` exists yet. This is a deliberate early-stage choice, not an oversight; contribution infrastructure may be added later.
