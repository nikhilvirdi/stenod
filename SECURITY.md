# Security

This document states, in plain language, exactly what Stenod captures, where it stores it, and precisely what its opt-in network-capture tier does and does not do. It describes the system as actually built and shipped. Where the running code currently falls short of the original design intent, that's called out explicitly below.

For the full architecture and design rationale, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## What's captured, by default

Running `stenod init && stenod start` captures **filesystem save events only**:

- `chokidar` watches your project directory. On every file save, the file's content is read and stored (`src/capture/watcher.ts`, `src/capture/file-state.ts`).
- Excluded, unconditionally: `.env` files, `.git/`, `node_modules/`, `dist/`, `build/`, `target/`, `.next/`, `.stenod/` itself, anything your project's own `.gitignore` already excludes, and any file over 500 KB (`src/capture/watcher.ts`).

**Terminal capture is active, but not automatic.** `stenod start` only captures filesystem events on its own — it never spawns a shell itself, because the daemon runs fully detached (no TTY to spawn one *into*). To also capture a terminal session, run `stenod attach` *in each terminal you want captured*, once per session: it spawns your real shell locally (`src/cli/attach.ts`, via `src/capture/terminal.ts`'s `TerminalWrapper` and `src/capture/batcher.ts`'s `TerminalBatcher` — reused as-is, not reimplemented), relays it live, and reports the accumulated output and exit code to the daemon over the token-authenticated local socket (`src/workspace/ipc.ts`) when the shell exits. The daemon writes the result via the same `writeTerminalNode()` (`src/capture/terminal-state.ts`) the rest of this capture track already uses — `src/daemon/terminal-bridge.ts` is the daemon-side handler. If you don't run `stenod attach`, terminal commands in that session aren't captured. `stenod start` alone doesn't do this automatically, unlike filesystem capture.

**Known gap in terminal capture via `stenod attach`:** long-running-process crash detection (the stderr-shape heuristic in `src/capture/terminal-heuristic.ts`, for processes like dev servers that never exit within a session) doesn't currently fire for `stenod attach` sessions — the daemon only receives the final accumulated content once the bridged shell exits, not live output as it streams. Only exit-code-driven `TERMINAL_SUCCESS`/`TERMINAL_ERROR` is guaranteed for bridged sessions; the heuristic secondary signal isn't.

## Opt-in: AI-provider network capture

Everything below only happens if you explicitly run `stenod enable-network-capture`. It's never triggered by `stenod init` or `stenod start` (confirmed: neither file imports anything from `src/network/`).

Running it does three things, in order (`src/network/enable-capture.ts`):

1. **Generates a local root CA** (`src/network/ca.ts`) and installs it into your OS trust store (`src/network/trust-store.ts`) — **per-user only**, never system-wide and never requiring admin/sudo: the macOS *login* keychain (not the System keychain), or a per-user NSS database at `~/.pki/nssdb` on Linux. The private key is written with `0o600` permissions (owner-only) on Linux/Mac; Windows doesn't support this tier at all (see Limitations below).
2. **Starts a local HTTPS interception proxy** (`src/network/proxy.ts`, via `mockttp`) that only decrypts traffic to three allowlisted domains: `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`. Enforcement is two-layered: TLS connections to any other hostname are never decrypted at all (relayed as raw encrypted bytes), and a second, independently-auditable hostname check gates what actually gets recorded. Everything else — any other site, any other app's traffic routed through the proxy — passes through untouched and is never logged.
3. **Records captured AI-provider responses** into your project's local causal graph as `PROVIDER_CAPTURE` rows (`src/network/provider-capture.ts`). The response stream to your actual AI tool is untouched — mockttp forwards it byte-for-byte; the daemon reads an independent copy via a separate event, not by modifying what you receive.

**What it doesn't do:**

- **It doesn't modify your shell's environment.** A background process can't set `HTTP_PROXY`/`HTTPS_PROXY` in the terminal that launched it — Stenod prints the proxy URL and asks you to export those variables yourself. Nothing routes through the proxy unless you do this.
- **Certificate-pinned applications won't be visible**, even with this tier enabled — they reject any CA that isn't their own hardcoded one, including this one. This is a structural limitation of TLS interception, not a bug.
- **Captured content never drives Stenod's own internal state machine.** `PROVIDER_CAPTURE` rows are stored as plain content only; the FSM that decides what's "still relevant" is driven exclusively by file saves and terminal exit codes (`src/lifecycle/fsm.ts` — there is no FSM event for provider capture at all; passing one throws at runtime).

**Full uninstall path:** `stenod disable-network-capture` (`src/network/disable-capture.ts`) removes the CA from your OS trust store, confirms the removal actually took effect by re-querying the trust store, and only then deletes the locally persisted CA files. If removal can't be confirmed, the local files are deliberately left in place rather than discarded, so you're not left unable to retry. This command works independently of whether the `enable-network-capture` process is still running — it reads only from what was persisted to disk, not from any in-memory state of a live process.

## Where everything is stored

Always local, always inside `<your project>/.stenod/`:

- `.stenod/graph.db` — a single SQLite file (`graph_nodes`, `graph_edges`, `manifest_log` tables — `src/storage/schema/`). Every captured event, every compiled manifest's audit record.
- `.stenod/token` — the local auth token (see below), `0o600` on Linux/Mac.
- `.stenod/daemon.pid` — the running daemon's PID lock file.
- `.stenod/ca/rootCA.pem` and `.stenod/ca/rootCA-key.pem` — only present if you've run `enable-network-capture`; removed by `disable-network-capture`.
- `.stenod/stenod.service` (Linux) or `.stenod/com.stenod.daemon.plist` (macOS) — a generated crash-recovery service unit, written by `stenod init` but not automatically registered with your OS — you'd install it yourself if you want auto-restart.

Nothing is ever sent anywhere else. A repo-wide search for outbound HTTP calls (`fetch`, `http.request`, `https.request`, `axios`) across all production source turns up **zero matches outside the opt-in network-capture tier itself**, and even there, the code only intercepts traffic *you* route through it — it never initiates a connection on its own.

## Secret protection

Two layers, applied identically to filesystem content, terminal output, and network capture:

1. **Primary:** `.env` files are never watched in the first place (`src/capture/watcher.ts`).
2. **Backstop:** before any content is hashed or stored, a regex pass (`src/capture/redaction.ts`) redacts common secret shapes — AWS/Google/GitHub/Slack/Stripe key patterns, `Authorization: Bearer` headers, and generic `secret=`/`token=`/`password=`-style assignments (the identifier stays visible; only the value is redacted). This is a heuristic, not a guarantee: an identifier that merely *contains* a word like "token" as a substring will also get redacted (over-redaction, not under-redaction, is the deliberate failure mode). This same pass runs before every write in `src/capture/file-state.ts`, `src/capture/terminal-state.ts`, and `src/network/provider-capture.ts` — confirmed by reading each call site directly, not inferred from a shared description.

## Local connection authentication

`stenod init` generates a 256-bit random token (`src/workspace/token.ts`), stored at `.stenod/token` with `0o600` permissions. `stenod start` now genuinely starts a local IPC server (Unix domain socket on Linux/Mac, named pipe on Windows — `src/workspace/ipc.ts`) that enforces this token on every connection: a client must send the current on-disk token within 5 seconds of connecting, or the connection is destroyed; a wrong or missing token gets an explicit rejection, not a silent hang. The token is re-read from disk on every connection (not cached), so `stenod init --reset` rotation takes effect immediately without restarting the daemon. The only client that currently connects is `stenod attach` (terminal capture, see above) — it authenticates with this same token before the daemon will accept anything from it.

## Known limitations

- **Windows:** the entire network-capture tier (CA generation, trust store install/uninstall) is unsupported — `installTrustStore()`/`uninstallTrustStore()` throw an explicit, labeled error rather than silently no-op-ing or failing partway through. `stenod attach` (terminal capture) is also Windows-unsupported, since it depends on `node-pty`, which is Unix/Mac only per this project's own scope.
- **macOS trust-store behavior** (install, verify, and uninstall) has been exercised by real automated tests on Linux CI only; it hasn't yet been manually confirmed on a real Mac.
- **Terminal capture requires an explicit, separate step.** `stenod start` alone captures filesystem events only — you must run `stenod attach` in each terminal session you want captured. This isn't automatic, and it's easy to forget.
- **Long-running-process crash detection doesn't fire for bridged `stenod attach` sessions** (see above) — only exit-code-driven `TERMINAL_SUCCESS`/`TERMINAL_ERROR` is guaranteed there, not the live stderr-heuristic secondary signal.
- **Zero telemetry is a hard invariant, not a policy promise.** There's no code path in this repository that sends data anywhere except the traffic you explicitly opt into and route through the local proxy yourself, and the terminal-capture bridge described above, which never leaves your own machine.
