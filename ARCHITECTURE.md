# Stenod : Architecture & Design

This document explains what Stenod is, the problem it solves, how each part works, and the reasoning behind the major design decisions. It's the reference for anyone who wants to understand the system beyond the [README](./README.md): how the capture layer, causal graph, compiler, and delivery path fit together, and why they were built this way.

For install and usage, see the [README](./README.md). For exactly what's captured and the security posture, see [SECURITY.md](./SECURITY.md).

**A note on versions.** Stenod 1.0 was a single daemon watching one project: filesystem saves, terminal exit codes, and an opt-in AI-provider network tap, compiled into a Handoff Manifest and copied to the clipboard. Everything below that isn't tagged otherwise is 1.0, still running, still true. Stenod 2.0 — the subject of most of this document — extends that same daemon to read the coding agents themselves (Claude Code, Codex, Kiro, Google Antigravity, Cursor), merge their reasoning into one shared graph, and interpret it into a current-truth scoreboard instead of a flat log. Same engine, wider ears.

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [Existing Solutions](#2-existing-solutions--strengths-and-shortcomings)
3. [What Stenod Is](#3-what-stenod-is)
4. [The Handoff Contract](#4-the-handoff-contract)
5. [Feature Overview](#5-feature-overview)
6. [Interfaces](#6-interfaces)
7. [System Architecture](#7-system-architecture)
8. [Tech Stack](#8-tech-stack)
9. [Why This Approach](#9-why-this-approach)
10. [Scope & Known Limitations](#10-scope--known-limitations)
11. [Security, Privacy & Trust](#11-security-privacy--trust)
12. [Companion Website](#12-companion-website)
13. [Open Source Posture](#13-open-source-posture)
14. [Evaluation Strategy](#14-evaluation-strategy)
15. [Cost](#15-cost)
16. [Design Decision Log](#16-design-decision-log)

---

## 1. The Problem

AI-assisted coding sessions collapse at boundaries: rate limits, provider outages, context-window exhaustion, or a developer deliberately switching tools mid-task. What's lost at that moment isn't just chat history. It's the *reasoning* — which architectural decisions were made and why, which approaches were tried and rejected, which constraints are still active, and what the developer was in the middle of doing.

This isn't hypothetical. When Windsurf moved to quota-based billing in March 2026, the user backlash was documented and specific: developers got rate-limited mid-session and lost their flow. The pain is current, not speculative.

Existing tools save conversations. What actually gets lost is the intent behind the conversation.

Widening the lens past a single tool, the same root cause shows up in sixteen distinct, mapped failure modes, which group into four clusters feeding one underlying problem — call it amnesia:

- **Session breaks** — context switching, session interruption or expiry, cross-machine continuity, an IDE failing to surface its own chat history, outright session auto-deletion.
- **Budget pressure** — a hidden or smaller-than-advertised context window, rate limits, lossy auto-compaction, compaction firing mid-task, cold-cache reloads that burn usage just to re-establish where things stood.
- **Memory decay** — stale or conflicting rule files (`CLAUDE.md`, `AGENTS.md`, IDE-specific rules), memory that goes stale without ever being re-checked, context bleeding across git branches or worktrees.
- **Recovery failure** — a raw history dump reviving an idea that was already killed, an agent re-deriving a bug fix that was already found.

All four feed the same root: work stops, and the reasoning doesn't survive the gap. A blank slate is at least honest about not knowing. A stale or half-remembered context is worse, because it lets an agent charge ahead confidently on a false premise.

Deliberately excluded from this list: agent execution-reliability issues like command loops or silently skipped steps. That's a different category — an agent behaving badly while it has full context — and not the problem Stenod is built to solve.

---

## 2. Existing Solutions — Strengths and Shortcomings

| System | What it does well | Where it falls short for this problem |
|---|---|---|
| **Mem0** | Widely adopted, large ecosystem, simple SDK integration | In-band — requires the agent/API to be alive to read or write memory. Its open-source repo appears to have gone quiet as of early 2026; the hosted product is still live |
| **Zep (Graphiti)** | Genuinely sophisticated temporal knowledge graph reasoning over conversational facts | Still in-band; models chat facts, not developer/codebase causal events; requires their service to be reachable |
| **Letta (MemGPT)** | Serious, research-backed OS-inspired memory architecture for agents | In-band by design — the memory manager is part of the agent loop it's serving |
| **MemPalace** | Markets itself as local-first with a zero-API-call philosophy | Its published benchmarks have been credibly called out as astroturfed; not a source to cite as evidence of anything |
| **Supermemory** | Deep MCP integration, positioned specifically for coding agents | Called via MCP tool — requires the agent to successfully invoke a tool call, i.e., requires the agent to be reachable |
| **projectmem** | Event-sourced, git-hook based, closest philosophical match to Stenod's own "memory as governance" framing | Still project-scoped rather than cross-tool; doesn't unify multiple concurrent agents into one graph |
| **claude-mem** | Genuinely mature multi-tool capture — hooks-based across Claude Code, Codex, Gemini CLI, Antigravity's CLI, and bridged into Cursor's own hook system | Its core mechanism is AI-summarization: it compresses everything into opaque "observations." No notion of rejected-with-reason, no current-truth model — exactly the lossy pattern this project avoids |
| **SpecStory** | Wraps CLI agents directly and captures editor extensions too (Cursor, Copilot), saving everything as searchable markdown | A raw, browsable archive, not an interpreted one. Solves "find that old conversation," not "hand me current truth" |
| **Windsurf Cascade Memories / Cursor Notepads** | Zero-setup, deeply integrated, genuinely useful day to day | Vendor-locked to one IDE's own agent process and quota; can't hand off to a different provider; dies with that tool's own outage or rate limit |
| **Manual copy-paste** | Requires no tooling at all | No filtering of dead ends or failed experiments, no chronology, triggers "Lost in the Middle" degradation on large dumps |
| **Git** | The actual system of record for code state | Captures *what changed*, not *why*, not which constraints are still active, not what was rejected and why |

Two patterns hold across this whole table. First, every in-band system shares a failure domain with the AI it's trying to help — none are built around the moment the AI itself is unreachable. Second, among the systems that do span multiple tools, none combine that reach with real handling of rejected content: they either summarize it away (claude-mem) or bury it undifferentiated in an archive (SpecStory). That combination — cross-tool reach, plus rejected decisions preserved as first-class facts with their reasons attached — is the actual gap Stenod fills.

---

## 3. What Stenod Is

Stenod is a local, deterministic, out-of-band daemon. It captures the causal history of a coding session — file changes, terminal outcomes, the reasoning surfaced by the AI tools themselves, and optionally raw AI-provider network traffic — and compiles it into an attention-structured Handoff Manifest the moment a developer needs to resume, in any AI tool, including one they weren't previously using, and across however many tools are working the same project at once.

The one sentence that matters: it's *not a better memory service — it's a system that doesn't share a failure domain with the AI it's recording.*

It isn't pitched as "the first AI memory system." That space is crowded and well-funded, as §2 shows. Stenod is a narrowly-scoped tool for one real, underserved failure mode: reasoning that dies the moment a session does.

The name comes from *stenographer* — someone who silently and exactly transcribes what happens for someone else to read later — and it reads naturally as a Unix daemon name (`stenod`, in the tradition of `sshd`, `httpd`).

---

## 4. The Handoff Contract

Everything Stenod produces is shaped by one contract, and it's worth stating on its own before getting into mechanism, because it's the thing that actually differentiates this project from the tools in §2.

Stenod doesn't try to classify a conversation into buckets after the fact. It maintains a live scoreboard of the project's current truth. Every new signal — a file change, a captured decision, a rejected approach — proposes an entry: `topic = answer`. If that topic is already on the board, the newer entry wins and the older one moves to history, but it is never deleted. It's marked, with the reason it lost, and kept permanently visible next to the decision that replaced it.

Concretely, every entry carries one of three states:

- **Settled** — the current, standing answer to some question the project has already resolved.
- **Rejected** — an approach that was tried or proposed and explicitly abandoned, with the reason it lost attached. First-class, not metadata — this is deliberate, and it survived pushback from outside reviewers who suggested demoting it (see the decision log).
- **Open** — a question raised but not yet resolved.

Nothing is ever silently overwritten and nothing is ever silently dropped. A fresh agent reading the board sees not just what's true now, but what was tried and rejected and why, so it can't re-propose a dead idea in good faith — the reason is sitting right there next to it.

---

## 5. Feature Overview

- **Multi-tool, multi-tier capture:** structured hooks where a tool exposes them (Claude Code, Codex, Kiro), plaintext session artifacts where it doesn't (Google Antigravity), a borrowed format parser for tools whose storage is undocumented (Cursor), and a filesystem-and-terminal fallback underneath all of them that works regardless of which tool is in front of it.
- **Causal graph storage** with typed edges (`REPLACES`, `CAUSED_BY`, `CONTRADICTS`, `DEPENDS_ON`, `RESOLVES`) instead of a vector store.
- **The scoreboard interpretation model** (§4) — settled / rejected / open, nothing deleted, rejected-with-reason first-class.
- **A three-layer, cost-aware interpreter** — deterministic structural rules, a local NLP pass, and an optional, fully user-controlled AI tie-breaker for the genuinely ambiguous residue.
- **Cross-tool timeline merge** — when several agents work one project concurrently, their file activity anchors a single shared timeline, and each tool's reasoning attaches to the file event it explains.
- **FSM-based intent classification** — distinguishes deliberate architectural decisions from panic fixes by state-transition pattern, not keyword heuristics.
- **Last-Writer-Wins conflict resolution** — contradicting decisions are resolved automatically rather than both landing in a future manifest as if still live.
- **Deterministic compiler** — greedy-by-ratio knapsack packing plus a local improvement pass, with a forced primacy zone for constraints and settled decisions.
- **U-shaped manifest structuring** — exploits transformer primacy/recency attention bias, citation-backed (Liu et al. *Lost in the Middle*, Xiao et al. *Attention Sinks*).
- **Two handoff views** — `--full` (the complete standing scoreboard) and `--new` (just what's changed since the last handoff), both compiled, neither ever a raw dump.
- **Stale rule-file detection** — Stenod reads a tool's own instruction files (`CLAUDE.md`, `.cursor/rules`, and similar) and flags them against current truth. It never edits them.
- **Dependency-change tracking** — package additions, removals, and swaps captured from manifest files as first-class decisions, not incidental noise.
- **"Next Actions" block** — surfaces the current unresolved state as an explicit next step, not just raw context.
- **Manifest audit log** — every compiled handoff is logged with its exact node selection, queryable and auditable.
- **Feedback tagging** (`--worked` / `--failed`) — the mechanism for ever having real data to justify tuning retrieval weights later.
- **Time-windowed rejection** (`--since <duration>`) — prune a bad session's nodes from all future manifests.
- **Secret protection, two layers** — never watching secret-adjacent paths at all (primary), regex redaction as a backstop (secondary).
- **Explicit, reversible tool integration** (`stenod integrate` / `stenod detach`) — wiring into a tool's hook system is opt-in and announced, the same way the network-capture tier already is.
- **Clean opt-in/opt-out** for the network capture tier, including full CA-cert removal.
- **Daemon crash recovery** via systemd/launchd auto-restart.
- **Schema versioning** for safe upgrades across releases.
- **Zero telemetry** — independently verifiable, since the project is open source.

---

## 6. Interfaces

The CLI is the primary interface. There is a companion website (§12), but it's a local, read-only view of what the CLI already produces — it doesn't replace it.

| Command | Purpose |
|---|---|
| `stenod init` | Set up daemon + DB for a project directory, generate local auth token, install systemd/launchd unit |
| `stenod start` | Start the ingestion daemon (filesystem capture) |
| `stenod stop` | Stop the daemon |
| `stenod status` | Daemon health, node count, last event timestamp, any stale rule files or flagged conflicts |
| `stenod attach` | Bridge the current interactive shell's terminal activity to the daemon (run per terminal session) |
| `stenod integrate <tool>` | Opt in to structured capture for a supported tool (Claude Code, Codex, Kiro, Antigravity, Cursor) — wires hooks or registers auxiliary watch paths, announced, reversible |
| `stenod detach <tool>` | Remove exactly what `integrate` added for that tool, and confirm the removal |
| `stenod handoff [--full \| --new]` | Compile and copy the Handoff Manifest to clipboard. Defaults to `--full`; a hint below the output points to `--new` for a leaner, latest-changes-only view |
| `stenod handoff --worked` / `--failed` | Tag the outcome of the most recent manifest in the audit log |
| `stenod reject --since <duration>` | Mark nodes in a time window as `REJECTED`, excluded from all future manifests |
| `stenod anchor "<text>"` | Create a `CONSTRAINT` node directly from the CLI |
| `stenod enable-network-capture` | Opt in to the AI-provider network capture tier (installs local CA, starts proxy) |
| `stenod disable-network-capture` | Fully revert the CA trust and proxy settings |
| `stenod mcp` | Run as an MCP server over stdio, exposing the handoff manifest as a resource |

**Terminal capture note:** `stenod start` alone captures filesystem events only. Terminal capture requires running `stenod attach` in each interactive shell you want captured — the daemon runs detached and has no TTY of its own to spawn a shell into.

**MCP convenience interface:** `stenod handoff` is also exposed as an MCP resource, so an already-reachable agent can pull the manifest directly instead of copy-pasting. This is additive convenience only; the system always degrades gracefully to clipboard-only.

---

## 7. System Architecture

### 7.1 Capture Layer

Every supported tool falls into one of four tiers, based on what it actually exposes — not on how much we'd like it to expose.

**Tier A — structured hooks (richest signal, official interface).** Claude Code, Codex, and Kiro each ship a lifecycle hook system: events like `SessionStart`, `PostToolUse`, `PreCompact`, and `Stop` fire structured JSON at exact semantic boundaries. Claude Code's own documentation is explicit that its raw session JSONL is internal and can change between releases — hooks are the sanctioned interface, and Stenod treats them as such. `PreCompact` is the standout: it fires immediately before the tool's own lossy auto-summarization runs, which means Stenod can snapshot the clean, un-summarized state at the one moment it would otherwise be lost. Kiro additionally writes `requirements.md`, `design.md`, and `tasks.md` straight into the repo as structured plaintext — much of a handoff's shape already built by the tool itself.

**Tier B — plaintext artifacts, no hooks.** Google Antigravity has no hook system, but it writes a full session record to `~/.gemini/antigravity/brain/<conversation-id>/` — a JSONL transcript plus maintained markdown artifacts (`implementation_plan.md`, `task.md`, `walkthrough.md`). Stenod reads this directly. This also happens to solve a specific, named pain point: Antigravity's own UI has been known to fail to surface its history, and reading the brain folder directly sidesteps that failure entirely.

**Tier C — borrowed parsers for undocumented formats.** Cursor's raw chat storage is an undocumented, versioned SQLite blob with no published schema, and it has changed shape multiple times already. Reverse-engineering it in-house would mean permanently chasing a format we don't control. Instead, Stenod borrows a maintained open-source parser for it, wrapped behind a thin adapter so the rest of the codebase never depends on that parser's types directly — if the format shifts again, only the adapter changes. Cursor's *agent* hook system (tool calls, file edits) is Tier A-equivalent and captured that way; only its human-facing chat UI storage falls into this tier.

**Tier 0 — filesystem and terminal, the fallback under everything.** `chokidar` watches the project directory, and `stenod attach` bridges terminal activity, exactly as in Stenod 1.0. This tier doesn't need any tool's cooperation — it watches the same shared filesystem regardless of which tool touched it, which means it already works for VS Code with GitHub Copilot and Windsurf, neither of which exposes anything more structured than this. It also means every tool, no matter its tier, gets at least the ground-truth signal of what changed and whether commands passed.

**Dependency-change capture.** Package additions, removals, and swaps are watched via the manifest files themselves — `package.json`, `requirements.txt`, `Cargo.toml` — and the exit codes of install commands, never by reading installed package contents. A dependency change becomes a `DECISION` node like any other, so a cold resume knows what the project currently depends on and what it tried and dropped.

**Integration is explicit and reversible.** `stenod integrate <tool>` writes Stenod's own hook entries into a tool's configuration additively, never touching anything already there, and prints exactly what it wrote. `stenod detach <tool>` removes exactly that, then re-reads the file to confirm the removal actually took effect — the same confirmed-clean-undo pattern the network-capture tier already uses. Neither command runs automatically from `init` or `start`.

**Hooks are configured globally but resolved per-project.** A tool's hook configuration is typically user-level, not project-level, so a single integration would otherwise fire for every project that tool touches. Stenod's hook script resolves the working directory of each event upward looking for a `.stenod/` directory; if one exists, the event is delivered there, and if not, the script exits immediately and captures nothing. One global hook, but capture only happens in projects that explicitly opted in.

**Antigravity's brain folder lives outside the project root.** Because it sits in the user's home directory rather than inside any project, `stenod integrate antigravity` registers it as an auxiliary watch path tied to a specific project, and matches conversations to that project by the workspace path they reference. A conversation that doesn't reference the current project is left alone rather than guessed at.

**Hook scripts never block the agent they're watching.** Every script Stenod installs is fire-and-forget: it hands its payload to the daemon over the existing authenticated socket and exits immediately. If the daemon is unreachable, the payload spools to a local file and the script still exits without waiting. A recorder that can stall the thing it's recording has stopped being out-of-band, so this is treated as a hard rule, not a best effort.

**Ingestion queue:** all tracks — hooks, brain-folder reads, filesystem, terminal — feed one serialized queue into WAL-SQLite, with overflow spilling to an append-only disk buffer, drained FIFO, never silently dropped.

**Security baseline, workspace sandboxing, and daemon crash recovery** are unchanged from 1.0: a token generated at `stenod init`, one daemon per resolved project root, and systemd/launchd auto-restart.

### 7.2 Storage Layer — Causal Graph

The three-table shape from 1.0 is extended, not replaced.

**`graph_nodes`** gains three things:

| column | type | notes |
|---|---|---|
| `type` | ENUM | now also includes `DECISION`, alongside the existing `FILE_STATE`, `TERMINAL_ERROR`, `TERMINAL_SUCCESS`, `PROVIDER_CAPTURE`, `CONSTRAINT` |
| `resolution` | ENUM, nullable | `SETTLED` / `REJECTED` / `OPEN` — populated only on `DECISION` nodes, governs scoreboard state |
| `resolution_reason` | TEXT, nullable | the "why" behind a rejection or a settled choice; required whenever `resolution = REJECTED` |
| `source_tool` | TEXT | which capture surface produced this node (`claude-code`, `antigravity`, `terminal`, `fs`, or `llm-tiebreaker` for an AI-confirmed match) |
| `git_branch` | TEXT, nullable | taken from hook payload metadata when present, otherwise read from `.git/HEAD` at capture time |
| `status` | ENUM | gains a new value, `SHADOWED`, alongside the existing `ACTIVE`, `REJECTED`, `SUPERSEDED` |

`status` and `resolution` answer two different questions and are deliberately kept as separate columns rather than one overloaded enum: `status` governs whether a node is live in the graph at all, `resolution` governs where a decision sits on the scoreboard.

**`graph_edges`** gains one edge type: `RESOLVES`, linking a later `DECISION` node to the `OPEN` node it answers, so the trail from question to answer is queryable the same way `REPLACES` already tracks supersession.

**`manifest_log`** is unchanged.

The migration runs through the existing `PRAGMA user_version` mechanism — old rows are backfilled with a best-guess `source_tool` from their existing node type, and everything else defaults to null. Nothing is rewritten or lost.

**Double-capture and shadowing.** Once a tool's hooks are integrated, the same event can be seen twice — once by the hook, once by the terminal track that's watching regardless. Because the two versions carry different text, content hashing alone won't catch the duplicate. When a hook event and a terminal event are matched — same command text, overlapping time window, same session — the terminal-track copy is marked `SHADOWED`: kept in the graph for audit, but excluded from the compiler's view, since the hook version is richer. Where a confident match can't be made, both are left active; a duplicate on the board costs a glance, a wrongly hidden node costs the whole point of keeping history.

### 7.3 Interpretation

Turning raw reasoning text into a scoreboard entry runs through three layers, cheapest first, and each layer is allowed to abstain rather than guess.

**Layer 0 — structural, no language involved.** Most decisions never need text interpretation at all. A file overwrite superseding an earlier file-state, a failing command followed by an edit that makes it pass, a dependency swap in a manifest file — these are read straight off the filesystem-and-exit-code spine, using the same FSM and Last-Writer-Wins machinery built for Stenod 1.0. This layer costs nothing and catches the majority of cases.

**Layer 1 — deterministic text signals.** For reasoning text that Layer 0 can't resolve, a fixed rule pass looks for high-confidence markers: explicit rejection language ("instead of", "let's not", "reverting"), decision language ("we'll use", "settled on"), and the existing constraint comment syntax. This layer is built on `wink-nlp` — a zero-dependency, offline, TypeScript-native library used for sentence splitting, tokenization, and negation detection, which is a meaningfully better foundation than hand-rolled regex for exactly the cases (negation scope, sentence boundaries) that regex handles worst. This layer only fires on genuine confidence and is expected, honestly, to resolve something on the order of half of ambiguous cases — the rest fall through.

**Layer 2 — an optional AI tie-breaker.** Whatever Layers 0 and 1 can't resolve goes here, and only here — never the full transcript, only the ambiguous span plus minimal surrounding context. This layer is entirely optional: without it configured, Stenod works completely, and anything this layer would have resolved simply lands as `OPEN` instead — a visible, flagged uncertainty rather than a silent guess. When enabled, it runs on the user's own API key, is triggered only at handoff time (never automatically, never in the background), and can be turned off entirely at any time.

**Topic identity.** Before two decisions can be compared, Stenod has to know they're about the same topic. The path here is the same shape as the interpretation cascade: an explicit `constraint[key]` match wins outright; failing that, Layer 1 looks for shared identifiers, a shared file, or explicit referential language ("instead of X"); failing that, both entries stay active and a `POSSIBLE_CONFLICT` marker is raised rather than either merging or duplicating silently. The optional Layer 2 tie-breaker can confirm or dismiss a flagged pair when enabled.

**Timing.** Layers 0 and 1 run continuously at ingest time, since they're free and deterministic — this is what keeps `status`, staleness flags, and conflict flags current between handoffs. Layer 2 runs only when a handoff is actually requested, and only if it's configured. Between handoffs, anything genuinely ambiguous simply sits as `OPEN`.

### 7.4 Cross-Tool Timeline Merge

When several agents work one project concurrently — one writing code, another reviewing it, a third running tests — their file activity already lands correctly ordered in one graph, because it's one filesystem with one clock. What doesn't automatically line up is each tool's *reasoning*, which arrives through separate channels with timestamps that can't always be trusted to agree.

The resolution: the filesystem is the backbone. A piece of reasoning is matched to the file event it explains — by which file it references first, and only by timestamp as a tiebreaker — rather than trusted to carry its own reliable clock. Reasoning that doesn't reference any file yet becomes an `OPEN` entry, resolved once a file event arrives to anchor it.

The one case this doesn't fully resolve: two agents writing the same file within the same second, with contradictory reasoning attached to each write. The filesystem still records a real write order even then, and Last-Writer-Wins applies exactly as it does for a single tool — but whether the second write was a deliberate override or an accidental collision isn't something capture alone can determine. Rather than guess, this is surfaced as a flagged, contested entry for the user to glance at.

### 7.5 Compilation & Delivery

The compiler from 1.0 — greedy-by-ratio packing, a local improvement pass, tiered content inclusion, U-shaped assembly — is unchanged in mechanism. What's new is what it's compiling and how much of it it shows.

**Two views, both compiled, neither a dump.** `stenod handoff --full` produces the complete standing scoreboard: every settled decision, and every rejected one with its reason, cleanly compiled — not the raw history of how each decision was reached. `stenod handoff --new` produces only what's changed since the previous handoff. Both run the same conflict resolution; a superseded decision never appears as if it were still live in either view. The bare `stenod handoff` defaults to `--full`, on the reasoning that a cold return should never accidentally get a thin picture — with a line underneath pointing to `--new` for the leaner option.

**Rejections surface as one-liners, always.** Every rejected decision appears in the manifest — nothing is held back — but through the same tiered-inclusion mechanism that already governs manifest content generally: a rejection reads as "what was rejected, and why," not as a replay of the discussion that led there. That's what lets "show every rejection, always" stay compatible with a manifest that doesn't bloat into the raw dump the whole project exists to avoid.

**Stale rule files are flagged, never edited.** Stenod reads a tool's own instruction files and checks them against the current scoreboard. A mismatch surfaces at the moments it's actually actionable — on `handoff`, on `status`, and the instant a new decision contradicts what a rule file claims — and it stays visible until the file is actually updated. It never fires on a timer, and Stenod never writes to these files itself; touching them would risk becoming a source of the exact staleness it's meant to catch.

### 7.6 Delivery

Clipboard copy remains the guaranteed path, with zero dependency on anything being reachable. The optional MCP exposure and the optional local dashboard (§12) are both convenience layers on top of it; both degrade gracefully to clipboard-only. Every compiled manifest is logged before delivery.

---

## 8. Tech Stack

The 1.0 stack is unchanged and carries forward as-is: Node.js/TypeScript, `better-sqlite3` (WAL), `chokidar`, `node-pty`, `web-tree-sitter`, `gpt-tokenizer`, `commander`, `mockttp` + `node-forge`, `@modelcontextprotocol/sdk`, `vitest`, `eslint` + `prettier`. Two additions for 2.0:

| Component | Choice | Why |
|---|---|---|
| Deterministic text interpretation (Layer 1) | `wink-nlp` | Zero runtime dependencies, MIT-licensed, fully TypeScript, runs offline — fits the no-network-calls and determinism invariants directly, and its sentence-boundary and negation handling is a real improvement over hand-rolled regex. Requires its language model package installed alongside it, and both are pinned to a supported Node version in CI |
| Tier-C format parsing | A borrowed, existing open-source parser for the target undocumented format, wrapped behind a thin Stenod-owned adapter | Reverse-engineering an undocumented, already-multiple-times-changed schema in-house means permanently chasing a format we don't control. The specific package is subject to the usual vetting — license, maintenance activity, dependency footprint — before being locked |

No Python, and none is planned. Embeddings and semantic scoring remain out of scope, which is what made the single-runtime choice sound in the first place, and a second language runtime would reintroduce exactly the cross-process bridge that decision was made to avoid.

---

## 9. Why This Approach

Restating §2's table as the core differentiation: Mem0, Zep, Letta, Supermemory, Cascade Memories, and Cursor Notepads are all in-band. claude-mem and SpecStory span multiple tools the way Stenod does, but neither preserves rejected decisions as first-class facts — one summarizes them away, the other buries them in an unsorted archive. Stenod is the only system in this comparison built around both properties at once: surviving the moment the AI is unreachable, and keeping what was rejected, and why, permanently visible rather than lossily compressed or lost in a pile.

Being open source strengthens this claim in a way a closed-source competitor structurally can't match. The "zero network calls except an explicit, user-controlled allowlist" promise is checkable by reading the code, rather than something a user has to take a vendor's word for.

---

## 10. Scope & Known Limitations

Deliberately out of scope for this version:

- Cross-file program-dependence-graph construction
- Adaptive or learned weight tuning (kept static and inspectable, by design)
- Full Windows terminal-capture support (`stenod attach` and the network tier remain Unix/Mac only)
- Any *required* AI dependency — the tie-breaker layer is opt-in end to end
- Certificate-pinned applications (invisible to the opt-in network tier)
- A hosted or cloud-relayed version of the dashboard — see §12's tripwire
- OpenAI's Codex is a supported Tier-A capture surface architecturally, but isn't currently a build priority
- VS Code with GitHub Copilot and Windsurf have no dedicated capture module — both fall back to Tier 0 (filesystem and terminal) only, since neither exposes a stable, documented session format or hook system worth building against
- Cursor's human-facing chat history remains Tier C (undocumented storage, borrowed parser); only its agent tool-call activity is captured with Tier-A richness
- Perfect ordering of two agents writing the same file within the same second, with genuinely contradictory intent — the filesystem gives a real write order and Last-Writer-Wins applies, but whether an override was deliberate isn't something capture alone can determine, so it's surfaced as a flagged, contested entry instead
- The AI tie-breaker's accuracy has a real ceiling on genuinely ambiguous language; because nothing is ever deleted, a mislabel is correctable, but not automatically caught

---

## 11. Security, Privacy & Trust

- **Zero telemetry, hard invariant** — no phone-home, ever, independently verifiable since the code is open.
- **Broad read reach, with a fixed, unchanged exclusion list** — `.env` files, `.git/`, `node_modules/`, build output, anything the project's own `.gitignore` excludes, and files over 500KB stay out of capture entirely, exactly as in 1.0. Dependency tracking reads manifest files and install outcomes only, never installed package contents.
- **Tool integration is opt-in and reversible** — `stenod integrate` / `stenod detach` follow the same announced-install, confirmed-uninstall pattern the network-capture tier already established, rather than silently modifying a tool's configuration.
- **Rule files are read-only** — Stenod flags staleness in a tool's own instruction files but never writes to them, which also means it can never become a source of the staleness it's built to catch.
- **The AI tie-breaker is fully optional and user-funded** — no key means the tool still works in full; a key, when supplied, is the user's own, spending only at handoff time, never silently.
- **The local dashboard never leaves the machine** — see §12.
- **Two-layer secret protection and auth on every local connection** carry forward unchanged from 1.0.
- **Full opt-out path** for the network tier, including CA removal, remains unchanged.

See [SECURITY.md](./SECURITY.md) for the plain-language account of exactly what is captured, where it's stored, and what each opt-in tier does and doesn't do.

---

## 12. Companion Website

A small website exists alongside the CLI, and it splits cleanly into two pieces that are easy to conflate but need to stay separate.

**A documentation site** — architecture, install steps, command reference, policies — is a normal static site, deployed and reachable like any project page. It reads no user data and talks to no daemon, so there's nothing sensitive about deploying it publicly.

**A live dashboard**, showing current handoffs and in-progress jobs updating in real time, runs entirely on the user's own machine: served from `localhost` by the user's own daemon, reading their own local database. This is not a hosted service, and there is no login, because there is nothing to log into — it's the user's own machine talking to itself.

This split exists because the alternative — routing a user's local data to a server so it can be viewed remotely, even with a stated policy of not persisting it — would turn "nothing is ever sent anywhere else" from a structural guarantee into a promise the user has to trust. That downgrade is precisely what separates Stenod from the in-band tools in §2, so it's treated as a hard line rather than a convenience trade-off. If remote viewing is ever built, the only architecture that preserves the guarantee is an end-to-end encrypted relay where the server never sees usable plaintext — a substantial project of its own, and not something to fold into a dashboard casually.

Both pieces of the website are sequenced after the capture-and-interpretation engine is working, not before. Building a dashboard against a data model that's still moving means building it twice.

---

## 13. Open Source Posture

- **License:** MIT.
- **Repo scaffolding:** README, LICENSE, SECURITY.md, and this document. There's no `CONTRIBUTING.md` and no active solicitation of external PRs at this stage — a deliberate early-stage stance. The license governs what others may legally do with the code; it says nothing about whether contributions are currently being reviewed. Contribution infrastructure can be added later without changing anything already built.
- **Distribution:** npm, package name `steno-daemon` (the CLI command itself is `stenod`).

---

## 14. Evaluation Strategy

No invented, unvalidated fidelity score. Two tiers, both honest:

1. **Native, cheap, deterministic:** exact-identifier recall — what fraction of function names, error codes, and variable names present in source nodes also appear verbatim in the compiled manifest. No ML, no embeddings, fully unit-testable. This now needs to run against multi-tool capture, not only the original filesystem-and-terminal source.
2. **External credibility reference:** LoCoMo and LongMemEval are the benchmarks the field's actual memory systems report against. Adopting one of these published methodologies later is more credible than a bespoke score nobody outside the project can verify.

---

## 15. Cost

Fully free. Node.js, SQLite, `chokidar`, `node-pty`, `web-tree-sitter`, `gpt-tokenizer`, `mockttp`, `node-forge`, and `wink-nlp` are all free, open-source packages. There's no hosted database, no vector DB service, and no cloud LLM calls during normal operation — the optional AI tie-breaker, when used, runs on the user's own key and their own dime, never the project's. There is no per-user or per-install cost for anyone who runs the tool.

---

## 16. Design Decision Log

A record of the material corrections made during design, kept so a future contributor understands *why* things are the way they are, not just what they are.

| Issue | Resolution |
|---|---|
| Early spec claimed both a greedy compiler and an FPTAS DP as current | Greedy-by-ratio plus a local-improvement pass is the actual algorithm; the FPTAS is out of scope, not silently half-implemented |
| Storage spec disagreed on 2 vs. 4 tables | Settled on 3 core tables; other proposed tables cut as orthogonal scope |
| A semantic-embedding fidelity score was listed as both in-scope and unvalidated | Cut entirely; replaced with exact-identifier recall (native) plus a reference to LoCoMo/LongMemEval (external) |
| Conflict resolution described as both "implemented" and "doesn't exist yet" | Last-Writer-Wins built as a first-class mechanism |
| Rejection semantics disagreed (count-based vs. time-based) | Time-window based (`--since`), matching FSM session boundaries |
| Recency decay formula divided by zero at Δt=0 | Fixed to `1 / (1 + ln(1 + Δt))` |
| Capture mechanism couldn't see IDE-native AI chat panels, only browser tabs | Generalized to a local HTTPS interception proxy covering any tool making outbound HTTPS calls |
| HTTPS interception originally implied as default-on | Made strictly opt-in |
| Package name collided with npm's similarity checks | Published as `steno-daemon`; the CLI command remains `stenod` |
| Full browser-chat capture module (extension, network-JSON capture, manual trigger) | Designed end to end, then shelved rather than deleted — no capture path a developer could fully trust, scope moved to terminal agents and agentic IDEs instead |
| Building a custom or small AI model to replace the tie-breaker | Rejected — understanding fuzzy, context-dependent language is what an LLM is for; no cheaper floor exists, and no labeled data exists to train one anyway |
| Hosting a shared AI account for the tie-breaker | Rejected — creates a bill that scales with every user, at odds with a free-tier-friendly, personal tool. User's own key instead |
| Silent, fully-automatic AI calls with no trigger | Rejected — spending someone's key invisibly is a trust violation. Capture is automatic; anything that spends or acts is user-triggered |
| Auto-injecting the handoff into a resumed session automatically | Rejected in favor of a manual button, for consistency with the no-silent-action principle, even though some tools support automatic injection |
| Reading a tool's own rule/instruction files and rewriting them | Rejected — read-and-flag only. Writing to them risks Stenod becoming a source of the exact staleness it's meant to catch |
| Continuous, timer-based staleness alerts | Rejected in favor of persistent-but-event-driven flags — surfaced at handoff, at status, and on a fresh contradiction, not on a repeating timer, to avoid training the user to ignore them |
| Demoting rejected alternatives to metadata | Raised independently by outside reviewers, overridden both times — first-class status stays, because it's the mechanism that actually prevents a dead idea from being re-proposed |
| Reverse-engineering Cursor's and VS Code's undocumented chat storage in-house | Rejected in favor of borrowing a maintained parser, wrapped behind an internal adapter, for the same reason a custom AI model was rejected — someone already maintains this better than a one-off effort would |
| Using Python for stronger NLP tooling | Rejected — would reintroduce a cross-language IPC bridge and a second runtime dependency, which the original Node-only choice specifically eliminated; the marginal gain doesn't clear that cost |
| Sending local handoff data to a hosted website, even without persisting it server-side | Rejected — "we don't store it" would be a policy promise, not a structural guarantee, undermining the exact thing that differentiates this project from in-band competitors |
| A website with login and cloud-synced handoffs | Rejected — the only architecture that would preserve the no-data-leaves-the-machine guarantee is end-to-end encryption with a server that sees no usable plaintext, which is a major project of its own, not a dashboard feature |
| Schema had no representation for decision state, tool provenance, or branch | Added `DECISION` node type, `resolution` / `resolution_reason` fields, `source_tool` and `git_branch` columns, and a `RESOLVES` edge type |
| No deterministic way to know two decisions are about the same topic | Added a three-rung matching ladder — explicit key, then deterministic inference, then flag-as-possible-conflict rather than guess |
| Assumption that AI tool hook payloads carry enough reasoning text was never verified | A capture-surface spike is the first build phase: wire minimal hooks, inspect real payloads, and confirm before any capture phase is built on the assumption |
| Hooks and the terminal-attach track can both capture the same event | Added `source_tool` provenance and a `SHADOWED` status — the richer hook copy is authoritative, the terminal-track duplicate is kept for audit but excluded from compilation |
| No process existed for wiring a tool's hooks into Stenod | Added `stenod integrate` / `stenod detach`, modeled directly on the existing opt-in, confirmed-undo pattern from the network-capture tier |
| Antigravity's session data lives outside any project root | Added an auxiliary watch-path registration, matched to a project by workspace path, skipped rather than guessed at when no match is confident |
| Tool hook configuration is global; Stenod's daemons are per-project | The hook script itself resolves each event's working directory upward for a `.stenod/` directory and delivers there, or exits silently if none exists |
