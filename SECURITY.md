# Security

This document states, in plain language, exactly what Stenod captures, where it stores it, and precisely what its opt-in tiers do and do not do. It describes the system as actually built and shipped, and — for the parts of Stenod 2.0 still in design — says so explicitly rather than describing unbuilt code as if it already existed.

For the full architecture and design rationale, see [ARCHITECTURE.md](./ARCHITECTURE.md).

**Version note:** everything under "What's captured, by default," "Opt-in: AI-provider network capture," "Secret protection," and "Local connection authentication" describes Stenod 1.0, shipped and cited against real source files. The sections on tool integration, the AI tie-breaker, and the companion dashboard describe Stenod 2.0, currently at the design stage — marked as such, with no file paths cited, since those files don't exist yet.

## What's captured, by default

Running `stenod init && stenod start` captures **filesystem save events only**:

- `chokidar` watches your project directory. On every file save, the file's content is read and stored (`src/capture/watcher.ts`, `src/capture/file-state.ts`).
- Excluded, unconditionally: `.env` files, `.git/`, `node_modules/`, `dist/`, `build/`, `target/`, `.next/`, `.stenod/` itself, anything your project's own `.gitignore` already excludes, and any file over 500 KB (`src/capture/watcher.ts`).

**Terminal capture is active, but not automatic.** `stenod start` only captures filesystem events on its own — it never spawns a shell itself, because the daemon runs fully detached (no TTY to spawn one *into*). To also capture a terminal session, run `stenod attach` *in each terminal you want captured*, once per session: it spawns your real shell locally (`src/cli/attach.ts`, via `src/capture/terminal.ts`'s `TerminalWrapper` and `src/capture/batcher.ts`'s `TerminalBatcher` — reused as-is, not reimplemented), relays it live, and reports the accumulated output and exit code to the daemon over the token-authenticated local socket (`src/workspace/ipc.ts`) when the shell exits. The daemon writes the result via the same `writeTerminalNode()` (`src/capture/terminal-state.ts`) the rest of this capture track already uses — `src/daemon/terminal-bridge.ts` is the daemon-side handler. If you don't run `stenod attach`, terminal commands in that session aren't captured. `stenod start` alone doesn't do this automatically, unlike filesystem capture.

**Known gap in terminal capture via `stenod attach`:** long-running-process crash detection (the stderr-shape heuristic in `src/capture/terminal-heuristic.ts`, for processes like dev servers that never exit within a session) doesn't currently fire for `stenod attach` sessions — the daemon only receives the final accumulated content once the bridged shell exits, not live output as it streams. Only exit-code-driven `TERMINAL_SUCCESS`/`TERMINAL_ERROR` is guaranteed for bridged sessions; the heuristic secondary signal isn't.

## Opt-in: capturing an AI tool's own reasoning (design stage, 2.0)

Everything in this section only happens if you explicitly run `stenod integrate <tool>`, once per tool. It's never triggered by `stenod init` or `stenod start`, and it never runs for a tool you haven't named.

**What `stenod integrate` does, by tool category:**

- **Claude Code, Codex, Kiro** — writes Stenod's own entries into that tool's hook configuration (for example `~/.claude/settings.json`), additively. Existing entries are never touched or removed, and the command prints exactly what it wrote and where. From then on, the tool itself calls a small Stenod-owned script at points in its own lifecycle (session start, a tool finishing, before it summarizes its own context), and that script hands the event to your project's daemon.
- **Google Antigravity** — registers its session-record folder (which lives in your home directory, not inside any project) as a watch path tied to this specific project. Only sessions whose own record references this project's path are captured; anything that doesn't match confidently is left alone.
- **Cursor** — bridges into Cursor's own agent hook system for tool calls and file edits. Cursor's separate, undocumented chat-history storage is not read by this integration; that would require a different mechanism, described below.

**What it doesn't do:**

- **A hook script can never block the tool it's watching.** Every script Stenod installs hands its event to the daemon and exits immediately, whether or not the daemon is reachable — if it isn't, the event is queued locally and delivered once the daemon is back. Stenod being slow, down, or broken can never stall an in-progress AI session.
- **It doesn't fire for projects that haven't opted in.** A tool's hook configuration is typically global to that tool, not per-project, so the hook script itself checks for a `.stenod/` directory in the current project before doing anything; if there isn't one, it exits without capturing or sending anything.
- **`stenod detach <tool>` removes exactly what was added**, then re-reads the configuration file to confirm the removal actually took effect, the same pattern `disable-network-capture` already uses below.

**Redaction applies identically here.** Any text captured through a hook or a session file goes through the same secret-shape redaction pass described under Secret Protection before it's ever written to disk.

**Reading Cursor's or another tool's raw chat-history storage**, where no hook system covers it, relies on a separate, maintained open-source parser for that specific undocumented format, wrapped behind Stenod's own adapter so a future format change in the underlying tool can't reach into Stenod's own code directly.

**Not yet confirmed:** the exact shape of what each tool's hooks report — how much of the assistant's own reasoning text actually rides along in the payload — is being verified against real tool output before this capture path is built out further. Until that's confirmed and shipped, treat this section as the design, not yet the code.

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

## Opt-in: AI tie-breaker for ambiguous decisions (design stage, 2.0)

Most of what Stenod captures is turned into a settled, rejected, or open entry using deterministic rules — no network call, no AI, nothing leaves your machine. A small remainder of genuinely ambiguous text can optionally be resolved by an AI model instead, and this is the one part of the design where a network call beyond the existing opt-in proxy tier is involved:

- **Off by default, and fully functional without it.** With no key configured, ambiguous items are simply flagged as open rather than auto-resolved. Nothing about this tier is required for Stenod to work.
- **Runs on your own API key**, never a key or account belonging to the project. Stenod pays nothing on your behalf and sends nothing on your behalf that you haven't already opted into.
- **Only the ambiguous span is sent, never the full transcript or the full graph.** A single unresolved sentence plus minimal surrounding context, not a session dump.
- **Only runs when you explicitly ask for a handoff**, never continuously and never in the background.

## Reading a tool's own rule and instruction files (design stage, 2.0)

Stenod reads a tool's own instruction files — `CLAUDE.md`, `.cursor/rules`, and similar — to compare what they claim against the project's current decisions, and flags a mismatch when one exists. **It never writes to these files.** This is read-only in both directions: nothing from a rule file is treated as more trustworthy than the graph's own record, and nothing Stenod concludes is ever written back into the file.

## Companion dashboard (design stage, 2.0)

An optional local dashboard, when built, will serve from `localhost` only, reading directly from your project's own `.stenod/graph.db`. It will not be reachable from any other machine, will have no login, and will send nothing to any server, because there is no server — just your own daemon talking to your browser, on the same computer. A separate, static documentation site is a normal public website and involves none of your project data at all; the two are unrelated.

## Where everything is stored

Always local, always inside `<your project>/.stenod/`:

- `.stenod/graph.db` — a single SQLite file (`graph_nodes`, `graph_edges`, `manifest_log` tables — `src/storage/schema/`). Every captured event, every compiled manifest's audit record. Once 2.0's schema additions ship, this also carries which tool a given entry came from and whether it's settled, rejected, or open — still the same local file, same location.
- `.stenod/token` — the local auth token (see below), `0o600` on Linux/Mac. The same token will authenticate hook-script connections once tool integration ships, exactly as it authenticates `stenod attach` today.
- `.stenod/daemon.pid` — the running daemon's PID lock file.
- `.stenod/ca/rootCA.pem` and `.stenod/ca/rootCA-key.pem` — only present if you've run `enable-network-capture`; removed by `disable-network-capture`.
- `.stenod/stenod.service` (Linux) or `.stenod/com.stenod.daemon.plist` (macOS) — a generated crash-recovery service unit, written by `stenod init` but not automatically registered with your OS — you'd install it yourself if you want auto-restart.

Nothing is ever sent anywhere else. A repo-wide search for outbound HTTP calls (`fetch`, `http.request`, `https.request`, `axios`) across all production source turns up **zero matches outside the opt-in network-capture tier itself**, and even there, the code only intercepts traffic *you* route through it — it never initiates a connection on its own. The one addition once 2.0's AI tie-breaker ships: an explicit, opt-in call to whichever provider your own key belongs to, sending only the ambiguous span described above, and only at handoff time.

## Secret protection

Two layers, applied identically to filesystem content, terminal output, network capture, and — once built — anything captured through a tool integration:

1. **Primary:** `.env` files are never watched in the first place (`src/capture/watcher.ts`).
2. **Backstop:** before any content is hashed or stored, a regex pass (`src/capture/redaction.ts`) redacts common secret shapes — AWS/Google/GitHub/Slack/Stripe key patterns, `Authorization: Bearer` headers, and generic `secret=`/`token=`/`password=`-style assignments (the identifier stays visible; only the value is redacted). This is a heuristic, not a guarantee: an identifier that merely *contains* a word like "token" as a substring will also get redacted (over-redaction, not under-redaction, is the deliberate failure mode). This same pass runs before every write in `src/capture/file-state.ts`, `src/capture/terminal-state.ts`, and `src/network/provider-capture.ts` — confirmed by reading each call site directly, not inferred from a shared description.

## Local connection authentication

`stenod init` generates a 256-bit random token (`src/workspace/token.ts`), stored at `.stenod/token` with `0o600` permissions. `stenod start` now genuinely starts a local IPC server (Unix domain socket on Linux/Mac, named pipe on Windows — `src/workspace/ipc.ts`) that enforces this token on every connection: a client must send the current on-disk token within 5 seconds of connecting, or the connection is destroyed; a wrong or missing token gets an explicit rejection, not a silent hang. The token is re-read from disk on every connection (not cached), so `stenod init --reset` rotation takes effect immediately without restarting the daemon. The only client that currently connects is `stenod attach` (terminal capture, see above) — it authenticates with this same token before the daemon will accept anything from it.

## Known limitations

- **Windows:** the entire network-capture tier (CA generation, trust store install/uninstall) is unsupported — `installTrustStore()`/`uninstallTrustStore()` throw an explicit, labeled error rather than silently no-op-ing or failing partway through. `stenod attach` (terminal capture) is also Windows-unsupported, since it depends on `node-pty`, which is Unix/Mac only per this project's own scope. Once built, Cursor's hook-based integration is expected to share this Unix/Mac-only restriction; hook-based integrations for Claude Code, Codex, and Kiro don't have the same `node-pty` dependency and aren't expected to.
- **macOS trust-store behavior** (install, verify, and uninstall) has been exercised by real automated tests on Linux CI only; it hasn't yet been manually confirmed on a real Mac.
- **Terminal capture requires an explicit, separate step.** `stenod start` alone captures filesystem events only — you must run `stenod attach` in each terminal session you want captured. This isn't automatic, and it's easy to forget.
- **Long-running-process crash detection doesn't fire for bridged `stenod attach` sessions** (see above) — only exit-code-driven `TERMINAL_SUCCESS`/`TERMINAL_ERROR` is guaranteed there, not the live stderr-heuristic secondary signal.
- **Reading Cursor's or another tool's undocumented chat-history storage depends on a third-party parser Stenod doesn't control**, wrapped behind an adapter specifically so a future format change there can't reach into Stenod's own code — but the underlying format itself is still the other tool's to change whenever it likes.
- **The AI tie-breaker has a real accuracy ceiling** on genuinely ambiguous language, same as any model would. Because nothing in the graph is ever deleted, a mislabel is correctable after the fact, but it isn't automatically caught.
- **Two agents writing the same file within the same second** are ordered correctly by the filesystem itself, but whether the later write was a deliberate override or an accidental collision isn't something capture can determine — it's surfaced as a flagged item rather than silently resolved either way.
- **Zero telemetry is a hard invariant, not a policy promise.** There's no code path in this repository that sends data anywhere except the traffic you explicitly opt into and route through the local proxy yourself, the terminal-capture bridge, the hook-based integrations, and the AI tie-breaker — each one running on your own opt-in and, where money's involved, your own key.