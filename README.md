## Stenod

*"Stenod is closed for now, for two reasons. First, the problem it tried to solve no longer seemed relevant to how I work. Second, it failed badly during testing. I have no plans to complete or fix it for a while, and this repository is kept for reference only."*

### What it was

Stenod was a local daemon for AI-assisted coding sessions. It was meant to record file changes, terminal activity, and, where a tool allowed it, the reasoning behind an AI agent's changes. It would then compile that record into a Handoff Manifest that a developer could paste into any AI tool to resume work after an interruption, such as a rate limit, a provider outage, or a switch between tools. The design aimed to run independently of any AI tool, so the record would survive even when the AI was unavailable.

The planned second version added structured capture from coding agents such as Claude Code, Codex, Kiro, Google Antigravity, and Cursor. It would merge their reasoning into one graph and track each decision as settled, rejected, or open.

### Features it offered

- Filesystem capture, which watched a project's files and recorded changes.
- Terminal capture through `stenod attach`, for interactive shells on Unix and Mac.
- Secret exclusion, which skipped `.env` files, `node_modules`, files listed in `.gitignore`, and files over 500KB.
- A causal graph stored in local SQLite, with typed edges between records.
- A compiler that packed the most useful records into a token budget and arranged them in a U-shaped structure.
- Clipboard delivery of the Handoff Manifest, plus an optional MCP resource.
- Constraint recording with `stenod anchor`, so a decision could be pinned for every future handoff.
- Time-window rejection with `stenod reject`, to remove a bad session from future handoffs.
- Outcome tagging with `--worked` and `--failed`, and an audit log of every compiled manifest.
- An opt-in network capture tier for AI-provider traffic, with a local certificate authority and a proxy. Unix and Mac only.

### Commands

| Command | Purpose | Testing result |
|---|---|---|
| `stenod init [--reset]` | Set up the daemon and database for a project | Worked |
| `stenod start [--project-root] [--foreground]` | Start the daemon | Worked, but did not confirm that the daemon had started |
| `stenod stop` | Stop the daemon | Worked |
| `stenod status` | Show daemon health and node count | Worked, but the count included rejected records |
| `stenod attach` | Capture the current shell's terminal activity | Not tested (Unix and Mac only) |
| `stenod integrate <tool>` | Turn on capture for an AI tool | Missing from the CLI, never built |
| `stenod detach <tool>` | Remove an integration | Missing from the CLI, never built |
| `stenod handoff [--worked] [--failed] [--token-budget]` | Compile and copy the Handoff Manifest | Worked, but file entries contained only filenames |
| `stenod handoff --full` | Show the complete current picture | Missing flag, although the default behaves the same way |
| `stenod handoff --new` | Show only changes since the last handoff | Missing, never built |
| `stenod anchor "<text>"` | Create a constraint record | Worked |
| `stenod reject --since <duration>` | Remove records from a time window | Worked, but also removed the current version of a working file |
| `stenod enable-network-capture` | Turn on AI-provider traffic capture | Not tested (Unix and Mac only) |
| `stenod disable-network-capture` | Remove the certificate and proxy settings | Not tested (Unix and Mac only) |
| `stenod mcp` | Run as an MCP server over stdio | Exercised, with no failures recorded |

### Install

```
npm install -g steno-daemon
```

The package is on npm at https://www.npmjs.com/package/steno-daemon. The package name is `steno-daemon`, and the command is `stenod`. On Windows, npm blocked the native build scripts for several dependencies, including `better-sqlite3`, the storage engine. The install only completed after the `--allow-scripts` flag was added, and the README never mentioned this step.

### Tech stack

| Area | Technology |
|---|---|
| Runtime | Node.js 20 or later, TypeScript |
| Storage | SQLite in WAL mode, through `better-sqlite3` |
| CLI | Commander.js |
| File watching | chokidar |
| Terminal capture | node-pty |
| Code parsing | web-tree-sitter |
| Text analysis | wink-nlp |
| HTTPS interception | mockttp |
| Certificate generation | node-forge |
| Agent integration | Model Context Protocol SDK |
| Testing | Vitest |
| Linting and formatting | ESLint, Prettier |

### Where it failed

- Handoff Manifests gave a new agent only bare filenames for file changes, with no summary of what had changed. A cold resume from the manifest carried no usable context about the project's most important file.
- Repeated saves to the same file never replaced earlier versions. One file accumulated 10 identical active records in a single session.
- The settled, rejected, and open scoreboard never produced entries from real code changes or from unresolved questions. The only content that appeared came from constraints added by hand with `stenod anchor`.
- The tool integrations for Claude Code, Codex, Kiro, Antigravity, and Cursor were never built. The commands `stenod integrate` and `stenod detach` do not exist in the CLI, although the documentation described them as available.
- The delta handoff `--new` was not built, and `--full` was missing as a flag.
- `stenod reject --since` removed every record in the time window, including the current version of a file that was still needed.
- `stenod status` counted rejected records, so its count did not match what the next handoff would contain.
- On Windows, the daemon stopped during a session without any warning, and its error log was empty. Capture stopped silently until someone noticed by hand.
- `stenod start` reported success without checking that the daemon had actually started.
- Dependency-change capture, the AI tie-breaker, and stale rule-file detection were documented but never implemented.
- The compiled package contained internal development comments, such as phase numbers and design references.
- The documentation described unbuilt features as if they were working.

### What worked

- Filesystem capture recorded file changes reliably throughout the test session.
- Secret files such as `.env` were excluded from capture, along with `node_modules` and files listed in `.gitignore`.
- Constraints added with `stenod anchor` appeared in the handoff with their full text.
- The automated tests for the first version were thorough, including real integration tests for the daemon lifecycle and the queueing logic.

### Testing setup

Testing was done on Windows. A full-stack project was built over a set of prompts while Stenod ran in the background. Commands that only work on Unix and Mac were not tested.

### License

MIT © Nikhil Virdi. See [LICENSE](./LICENSE).
