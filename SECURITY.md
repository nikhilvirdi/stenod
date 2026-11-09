## Security

This document describes what Stenod captures, where it stores it, and what its opt-in features do. It separates three things: what was built, what was tested, and what was never built. The project is closed. None of the security claims here were independently audited.

For the design and its reasoning, see [ARCHITECTURE.md](./ARCHITECTURE.md). For the testing findings, see the README.

### Summary

| Area | Status |
|---|---|
| Filesystem capture and `.env` exclusion | Built and tested on Windows |
| Other ignore rules (`.git`, `node_modules`, `.gitignore` paths, large files) | Built. Testing confirmed `.gitignore` paths and `.env` files were never captured. |
| Secret redaction | Built, not tested |
| Terminal capture (`stenod attach`) | Built, not tested (Unix and Mac only) |
| Local token and IPC authentication | Built, not tested |
| AI-provider network capture | Built, not tested (Unix and Mac only) |
| Tool integration (`stenod integrate`, `stenod detach`) | Never built |
| AI tie-breaker | Never built |
| Rule-file reading | Never built |
| Local dashboard | Never built |

### What Is Captured by Default

Running `stenod init` and `stenod start` captures filesystem save events only. On each save, the daemon reads the file's content and stores it.

The following paths are excluded: `.env` files, `.git/`, `node_modules/`, `dist/`, `build/`, `target/`, `.next/`, the `.stenod/` folder itself, anything listed in the project's `.gitignore`, and files over 500 KB. Testing confirmed that `.env` files and `.gitignore` paths were never captured.

### Terminal Capture

`stenod start` does not capture terminal activity. To capture a shell, run `stenod attach` in that shell. The command starts the shell, relays its output, and sends the accumulated output and exit code to the daemon when the shell exits.

Two limitations apply. The daemon records one aggregate entry per shell session, not one entry per command. It also records only the exit code and final output. The stderr heuristic that was meant to detect crashed long-running processes never runs, because the code that called it was disconnected during development. Terminal capture was not tested, because it works only on Unix and Mac.

### Opt-in: AI-Provider Network Capture

This tier runs only if the user runs `stenod enable-network-capture`. `stenod init` and `stenod start` do not start it.

When enabled, the command creates a local root certificate authority and installs it in the current user's trust store. It does not install the certificate system-wide and does not need administrator rights. A local HTTPS proxy then decrypts traffic to three allowlisted domains: `api.anthropic.com`, `api.openai.com`, and `generativelanguage.googleapis.com`. Connections to any other host are relayed without decryption. A second hostname check runs before anything is recorded.

Captured responses are stored as `PROVIDER_CAPTURE` records. The proxy forwards the response to the application unchanged, and the daemon reads a separate copy.

The tier does not change the user's environment. The user must set `HTTP_PROXY` and `HTTPS_PROXY` in their shell to route traffic through the proxy. Applications that pin their own certificates cannot be intercepted, even with this tier enabled. Captured content does not affect the state machine that tracks file and terminal events.

`stenod disable-network-capture` removes the certificate from the trust store and checks that the removal took effect. It deletes the local certificate files only after that check succeeds. This command was designed to work even if the enabling process is no longer running. Neither command was tested.

### Tool Integration (Never Built)

The design included `stenod integrate <tool>` and `stenod detach <tool>`. Neither command exists in the CLI, and no hook scripts were written.

The design planned these rules. Integration would add entries to a tool's hook configuration without changing existing entries, and it would print what it changed. Hook scripts would hand each event to the daemon and exit at once, so an unreachable daemon could never block the tool. Each hook would check for a `.stenod/` folder in the current project and do nothing if none existed. `detach` would remove exactly what `integrate` had added.

### AI Tie-Breaker (Never Built)

The design included an optional AI model to resolve ambiguous decisions. It would be off by default, use the user's own API key, send only the ambiguous text and minimal context, and run only at handoff time. No client code exists.

### Rule Files (Never Built)

The design included reading a tool's instruction files, such as `CLAUDE.md` and `.cursor/rules`, to flag where they disagreed with recorded decisions. It also specified that Stenod would never write to those files. No reader exists.

### Dashboard (Never Built)

The design included a read-only dashboard served from `localhost` and reading the project's own database. It was never built.

### Where Data Is Stored

Everything is stored inside `<your project>/.stenod/`:

- `graph.db`: the SQLite database of captured records and the manifest log. It contains captured file contents, which may include code, so it should be treated as sensitive.
- `token`: the local authentication token. On Unix and Mac it is readable only by its owner.
- `daemon.pid`: the running daemon's process lock file.
- `ca/`: the certificate files, present only while network capture is enabled.
- A service unit file, written by `stenod init` on Unix and Mac. It is not registered with the operating system automatically. Testing did not cover this file.

The `.stenod/` folder holds the token and captured data, so it must never be committed to version control or shared.

### Network Calls

The design committed to no outbound network calls, apart from the opt-in proxy and the planned tie-breaker. Telemetry was never part of the design, and no telemetry code was written. This was not verified during testing. To check the source yourself, run this from the project root:

```
Get-ChildItem src -Recurse -Filter *.ts | Select-String -Pattern "fetch\(|https\.request|http\.request|axios"
```

Matches inside test files are expected, since tests may mock network calls.

### Secret Protection

Two layers were built to limit stored secrets:

1. The file watcher never watches `.env` files. Testing confirmed this.
2. Before content is stored, a pattern-based redaction pass replaces common secret formats. It covers key formats for several cloud and developer services, `Authorization: Bearer` headers, and assignments such as `secret=`, `token=`, and `password=`. The name of the variable stays visible, and only the value is replaced.

Redaction is a heuristic. It can miss secret formats it does not recognize. It can also over-redact, for example when an identifier contains the word "token". Redaction was designed to run on file content, terminal output, and provider responses. It was not tested.

### Local Connection Authentication

`stenod init` generates a 256-bit random token and stores it in `.stenod/token`. The daemon's local IPC server requires the current token from any client within five seconds of connecting. A wrong or missing token gets an explicit rejection. The token is read from disk on each connection, so a token reset applies without restarting the daemon. The only client designed to connect is `stenod attach`.

This was not tested. Testing showed that `stenod start` reports success without confirming that the daemon is running, so the IPC server's startup was not verified either.

### Known Limitations

- Windows supports filesystem capture only. The network tier cannot be installed there, and `stenod attach` depends on `node-pty`, which is Unix and Mac only.
- The macOS trust-store code was tested on Linux CI only, not on a real Mac.
- Terminal capture requires a separate `stenod attach` command in each shell, which is easy to forget.
- Storage write failures are caught and discarded without a log entry. This keeps the daemon running, but a failed write leaves no trace, so missing records cannot be diagnosed.
- During testing on Windows, the daemon stopped during a session with no warning and an empty error log. The cause was not confirmed.
- Captured content does not include undocumented chat storage from other tools. That capture was designed but never built.
- The AI tie-breaker, the rule-file reader, and the dashboard were never built, so their accuracy and safety are untested.