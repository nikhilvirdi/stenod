# Stenod : Architecture & Design

This document explains what Stenod is, the problem it solves, how each part works, and the reasoning behind the major design decisions. It's the reference for anyone who wants to understand the system beyond the [README](./README.md): how the capture layer, causal graph, compiler, and delivery path fit together, and why they were built this way.

For install and usage, see the [README](./README.md). For exactly what's captured and the security posture, see [SECURITY.md](./SECURITY.md).

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [Existing Solutions](#2-existing-solutions--strengths-and-shortcomings)
3. [What Stenod Is](#3-what-stenod-is)
4. [Feature Overview](#4-feature-overview)
5. [Interfaces](#5-interfaces)
6. [System Architecture](#6-system-architecture)
7. [Tech Stack](#7-tech-stack)
8. [Why This Approach](#8-why-this-approach)
9. [Scope & Known Limitations](#9-scope--known-limitations)
10. [Security, Privacy & Trust](#10-security-privacy--trust)
11. [Open Source Posture](#11-open-source-posture)
12. [Evaluation Strategy](#12-evaluation-strategy)
13. [Cost](#13-cost)
14. [Design Decision Log](#14-design-decision-log)

---

## 1. The Problem

AI-assisted coding sessions collapse at boundaries: rate limits, provider outages, context-window exhaustion, or a developer deliberately switching tools mid-task. What's lost at that moment isn't just chat history. It's the *reasoning* — which architectural decisions were made and why, which approaches were tried and rejected, which constraints are still active, and what the developer was in the middle of doing.

This isn't hypothetical. When Windsurf moved to quota-based billing in March 2026, the user backlash was documented and specific: developers got rate-limited mid-session and lost their flow. The pain is current, not speculative.

Existing tools save conversations. What actually gets lost is the intent behind the conversation.

---

## 2. Existing Solutions — Strengths and Shortcomings

| System | What it does well | Where it falls short for this problem |
|---|---|---|
| **Mem0** | Widely adopted, well-funded, large ecosystem, simple SDK integration | In-band — requires the agent/API to be alive to read or write memory |
| **Zep (Graphiti)** | Genuinely sophisticated temporal knowledge graph reasoning over conversational facts | Still in-band; models chat facts, not developer/codebase causal events; requires their service to be reachable |
| **Letta (MemGPT)** | Serious, research-backed OS-inspired memory architecture for agents | In-band by design — the memory manager is part of the agent loop it's serving |
| **MemPalace** | Local-first, zero-API-call philosophy, credible public benchmarks (LongMemEval, LoCoMo) | Still fundamentally an in-band memory store an agent queries; not built around surviving the agent being unreachable |
| **Supermemory** | Deep MCP integration, positioned specifically for coding agents | Called via MCP tool — requires the agent to successfully invoke a tool call, i.e., requires the agent to be reachable |
| **Windsurf Cascade Memories / Cursor Notepads** | Zero-setup, deeply integrated, genuinely useful day to day | Vendor-locked to one IDE's own agent process and quota; can't hand off to a different provider; dies with that tool's own outage or rate limit |
| **Manual copy-paste** | Requires no tooling at all | No filtering of dead ends/failed experiments, no chronology, triggers "Lost in the Middle" degradation on large dumps |
| **Git** | The actual system of record for code state | Captures *what changed*, not *why*, not which constraints are still active, not what was rejected and why |

The pattern is consistent: every serious alternative is in-band. It shares a failure domain with the thing it's trying to help. None are built around the moment the AI itself is unreachable.

---

## 3. What Stenod Is

Stenod is a local, deterministic, out-of-band daemon. It captures the causal history of a coding session — file changes, terminal outcomes, and optionally AI-provider network traffic — and compiles it into an attention-structured Handoff Manifest the moment a developer needs to resume in any AI tool, including one they weren't previously using.

The one sentence that matters: it's *not a better memory service — it's a system that doesn't share a failure domain with the AI it's recording.*

It isn't pitched as "the first AI memory system." That space is crowded and well-funded, as §2 shows. Stenod is a narrowly-scoped tool for one real, underserved failure mode.

The name comes from *stenographer* — someone who silently and exactly transcribes what happens for someone else to read later — and it reads naturally as a Unix daemon name (`stenod`, in the tradition of `sshd`, `httpd`).

---

## 4. Feature Overview

- **Two-tier capture:** zero-trust default (filesystem + terminal), explicit opt-in for AI-provider network capture.
- **Causal graph storage** with typed edges (`REPLACES`, `CAUSED_BY`, `CONTRADICTS`, `DEPENDS_ON`) instead of a vector store.
- **FSM-based intent classification** — distinguishes deliberate architectural decisions from panic fixes by state-transition pattern, not keyword heuristics.
- **Last-Writer-Wins conflict resolution** — contradicting constraints are resolved automatically, rather than both being silently injected into a future manifest.
- **Deterministic compiler** — greedy-by-ratio knapsack packing plus a local-improvement pass, with a forced primacy zone for constraints.
- **U-shaped manifest structuring** — exploits transformer primacy/recency attention bias, citation-backed (Liu et al. *Lost in the Middle*, Xiao et al. *Attention Sinks*).
- **"Next Actions" block** — surfaces the FSM's current unresolved state as an explicit next step, not just raw context.
- **Manifest audit log** — every compiled handoff is logged with its exact node selection, queryable and auditable.
- **Feedback tagging** (`--worked` / `--failed`) — the mechanism for ever having real data to justify tuning retrieval weights later.
- **Time-windowed rejection** (`--since <duration>`) — prune a bad session's nodes from all future manifests.
- **Secret protection, two layers** — never watching secret-adjacent paths at all (primary), regex redaction as a backstop (secondary).
- **Clean opt-in/opt-out** for the network capture tier, including full CA-cert removal.
- **Daemon crash recovery** via systemd/launchd auto-restart.
- **Schema versioning** for safe upgrades across releases.
- **Zero telemetry** — independently verifiable, since the project is open source.

---

## 5. Interfaces

The CLI is the primary interface. There's no web dashboard, which is a deliberate scope choice.

| Command | Purpose |
|---|---|
| `stenod init` | Set up daemon + DB for a project directory, generate local auth token, install systemd/launchd unit |
| `stenod start` | Start the ingestion daemon (filesystem capture) |
| `stenod stop` | Stop the daemon |
| `stenod status` | Daemon health, node count, last event timestamp |
| `stenod attach` | Bridge the current interactive shell's terminal activity to the daemon (run per terminal session) |
| `stenod handoff` | Compile and copy the Handoff Manifest to clipboard |
| `stenod handoff --worked` / `--failed` | Tag the outcome of the most recent manifest in the audit log |
| `stenod reject --since <duration>` | Mark nodes in a time window as `REJECTED`, excluded from all future manifests |
| `stenod anchor "<text>"` | Create a `CONSTRAINT` node directly from the CLI |
| `stenod enable-network-capture` | Opt in to the AI-provider network capture tier (installs local CA, starts proxy) |
| `stenod disable-network-capture` | Fully revert the CA trust and proxy settings |
| `stenod mcp` | Run as an MCP server over stdio, exposing the handoff manifest as a resource |

**Terminal capture note:** `stenod start` alone captures filesystem events only. Terminal capture requires running `stenod attach` in each interactive shell you want captured — the daemon runs detached and has no TTY of its own to spawn a shell into.

**MCP convenience interface:** `stenod handoff` is also exposed as an MCP resource, so an already-reachable agent can pull the manifest directly instead of copy-pasting. This is additive convenience only; the system always degrades gracefully to clipboard-only.

---

## 6. System Architecture

### 6.1 Capture Layer

**Default tier (zero trust required):**

- **Filesystem:** `chokidar` watches the project directory. On save, content is parsed by `web-tree-sitter` in a background thread (AST parse under ~10ms; explicit `tree.delete()`/`parser.delete()` in `finally` blocks prevents memory leaks). It excludes `.env`, `.git/`, `node_modules/`, common build output dirs, anything the project's own `.gitignore` excludes, and binaries over 500KB.
- **Terminal:** `node-pty` wraps the developer's shell (via `stenod attach`), batching output at 16ms intervals with a 64KB backpressure high-water mark (overflow spills to a temp file, the stream pauses, then resumes after flush). The success/failure signal is the **shell exit code** for commands that terminate — language-agnostic, and it doesn't depend on matching test-runner-specific output strings. Long-running processes that never exit within a session (dev servers, `docker compose up`) are additionally watched for stderr matching common crash shapes (`Error:`, `Traceback`, `panic:`, unhandled rejection patterns), an explicitly-labeled best-effort secondary signal.

**Opt-in tier (`stenod enable-network-capture`):**

- A local HTTPS interception proxy, rather than a per-IDE integration, since AI providers are reached over HTTPS regardless of which surface (browser tab, Cursor, Windsurf, and so on) initiates the call. This single mechanism replaces what a separate browser extension and a separate "IDE integration" would each have had to duplicate.
- It generates a local root CA, installed into the OS trust store only when this command is explicitly run — never silently.
- It routes traffic via `HTTP_PROXY`/`HTTPS_PROXY`, **allowlisting known AI-provider domains only** (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`). Everything else passes through untouched and unlogged. This allowlist is plain, readable code, independently verifiable by anyone who installs the tool.
- SSE/streaming responses are `.tee()`'d: one stream continues to the caller unmodified, the other feeds the daemon.
- A stated limitation: certificate-pinned applications refuse the local CA and won't be visible, even with this tier enabled.
- `stenod disable-network-capture` fully reverts the CA and proxy settings. A trust ask needs an equally clear undo path.

**Ingestion queue:** all tracks feed one serialized queue into WAL-SQLite. There's a shared max in-flight depth; overflow spills to an append-only disk buffer, drained FIFO, never silently dropped. Target write latency is under 5ms.

**Security baseline:** every local socket/proxy connection requires a token generated at `stenod init`, stored in `.stenod/token`, rotated via `stenod init --reset`.

**Workspace sandboxing:** one daemon per resolved project root, DB at `<project>/.stenod/graph.db`, with a PID lock file to prevent a second daemon attaching to the same root.

**Daemon crash recovery:** `stenod init` generates a systemd user unit (Linux) or launchd plist (Mac) with `Restart=on-failure`.

### 6.2 Storage Layer — Causal Graph

**Why a typed-edge graph, not a vector store:** vector similarity clusters "use MongoDB" and "switch to PostgreSQL" together because they're semantically close — exactly wrong for a system whose job is knowing which one is *still true*. (This insight isn't unique to Stenod; Zep's Graphiti applies similar temporal-graph thinking to conversational facts. What differs here is scope — developer/codebase causal events, not chat facts — and mechanism: out-of-band capture, zero API dependency at read time.)

The graph uses three tables.

**`graph_nodes`**
| column | type | notes |
|---|---|---|
| `id` | TEXT (PK) | SHA-256 of content |
| `event_id` | INTEGER | monotonic, for WAL crash-recovery ordering |
| `type` | ENUM | `FILE_STATE`, `TERMINAL_ERROR`, `TERMINAL_SUCCESS`, `PROVIDER_CAPTURE`, `CONSTRAINT` |
| `content` | TEXT | redacted payload |
| `fsm_state` | ENUM | `IDE_IDLE`, `RUNTIME_ERR`, `DOC_EDIT`, `DIFF_SUBMIT`, `PROVISIONAL_PANIC` |
| `constraint_key` | TEXT, nullable | LWW conflict key, `CONSTRAINT` nodes only |
| `status` | ENUM | `ACTIVE`, `REJECTED`, `SUPERSEDED` |
| `source_file` | TEXT, nullable | |
| `created_at` | INTEGER | epoch ms |

**`graph_edges`**
| column | type | notes |
|---|---|---|
| `id` | TEXT (PK) | |
| `from_node_id` / `to_node_id` | TEXT (FK) | |
| `edge_type` | ENUM | `REPLACES`, `CAUSED_BY`, `CONTRADICTS`, `DEPENDS_ON` |
| `created_at` | INTEGER | |

**`manifest_log`**
| column | type | notes |
|---|---|---|
| `id` | TEXT (PK) | |
| `created_at` | INTEGER | |
| `node_ids` | TEXT | JSON array of node IDs selected into this manifest |
| `token_count` | INTEGER | |
| `outcome` | ENUM, nullable | `WORKED` / `FAILED`, set via `stenod handoff --worked`/`--failed` |

Storage runs with `PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-64000`. Schema version is tracked via `PRAGMA user_version`, and `stenod start` runs pending migrations before attaching.

**Constraint syntax:** `// VCS: constraint[key]=value` (or the equivalent per-language comment syntax), recognized wherever tree-sitter identifies a comment node. It's language-agnostic, since it matches comment text rather than code structure.

**Language scope:** tree-sitter grammars for JavaScript/TypeScript at launch, matching the tool's own stack. Additional grammars are a natural, well-bounded category of future contribution, since tree-sitter grammars are modular by design.

### 6.3 Lifecycle, Conflict Resolution, Decay

**FSM:** `IDE_IDLE → RUNTIME_ERR` (stderr/nonzero exit) `→ DOC_EDIT` (save) `→ DIFF_SUBMIT` (commit). A direct `RUNTIME_ERR → DIFF_SUBMIT` skip is tagged `PROVISIONAL_PANIC` and excluded from manifests unless explicitly anchored.

`PROVIDER_CAPTURE` nodes are stored as content but do **not** drive FSM transitions. Transitions stay driven exclusively by terminal exit codes and file saves, the two unambiguous ground-truth signals. Classifying intent from AI conversation text would reintroduce exactly the kind of content heuristic the FSM exists to avoid.

**Recency decay:**
```
decay(Δt) = 1 / (1 + ln(1 + Δt_seconds))
```
It's monotonic, has no singularity, and decay(0) = 1. The naive form `1/ln(1+Δt)` is undefined at Δt=0 — a new node yields ln(1)=0, i.e. division by zero — which is why the `1 +` term sits inside the denominator.

**Conflict resolution (Last-Writer-Wins):** a new `CONSTRAINT` node sharing a `constraint_key` with an `ACTIVE` constraint draws a `CONTRADICTS` edge to it and flips the old node to `SUPERSEDED`. The compiler excludes anything not `ACTIVE`, unconditionally.

**Rejection:** `stenod reject --since 15m` is time-windowed to match FSM session boundaries rather than arbitrary node counts. It's a pure graph-metadata operation (`status = REJECTED`); verifying deletion from the filesystem is git's job, not this system's.

**Anti-rot:** an FSM stuck in `RUNTIME_ERR` for τ > 600s seals the active tree and applies decay.

### 6.4 Compilation Engine

The utility score per node is `v_i = λ1·decay(Δt) + λ2·causal_centrality + λ3·constraint_priority`, with static constants `λ1=0.4, λ2=0.4, λ3=0.2` — fixed, not learned, consistent with the whole system's determinism principle. `causal_centrality` is simple in/out-degree within the node's own edge set: cheap, O(V+E), and sufficient at realistic single-project graph sizes.

One precision point is worth documenting, since it's easy to get wrong. Dantzig's greedy-by-ratio is provably optimal for the *fractional* knapsack problem, but it carries **no formal optimality guarantee for 0/1 knapsack**, which is what node selection actually is (a node is either in the manifest or not). The algorithm:

1. Traverse the graph, drop anything `status != ACTIVE`.
2. Force-include all `CONSTRAINT` nodes → primacy zone, regardless of score.
3. Sort remaining nodes by `v_i / token_cost` descending.
4. Pack until the token budget is hit.
5. **Local improvement pass:** for the lowest-value included node, check whether swapping it for the highest-value excluded node that still fits improves total value. Repeat until no improving swap exists.

This is a standard, cheap heuristic upgrade to plain greedy — no O(n²·1/ε) DP matrix needed. If a *proven* optimality bound is ever required, that's the honest reason to build the DP, not because greedy is "wrong" as-is.

**Tiered content inclusion:** each packed node carries actual content, tiered by importance so the manifest reads as a briefing rather than a raw dump. `CONSTRAINT` nodes carry full content; nodes with `utilityScore ≥ 0.6` carry a bounded excerpt (capped at 300 tokens); everything else carries a short deterministic one-line summary (`"{type} in {source_file}"`). Token cost reflects the tier actually emitted, and all thresholds are fixed constants — no LLM or summarization step, consistent with the zero-LLM-dependency guarantee.

**Token counting:** a local, offline tokenizer (`gpt-tokenizer`) measures `token_cost` per node, with zero network calls, consistent with the offline guarantee.

**Output structure (U-shaped):** constraints (primacy zone) → packed causal graph (middle) → exact resume instruction plus the "Next Actions" block, derived from the FSM's current unresolved state (recency zone). This exploits the well-documented transformer tendency to attend most strongly to the beginning and end of a context window.

### 6.5 Delivery

Clipboard copy is the guaranteed path, with zero dependency on anything being reachable — the entire point of the project. The optional MCP exposure is convenience only, and it degrades gracefully to clipboard-only if unavailable. Every compiled manifest is logged (`manifest_log`) before delivery.

---

## 7. Tech Stack

| Component | Choice | Why |
|---|---|---|
| Runtime | Node.js / TypeScript | Event-loop concurrency matches the high-frequency I/O capture pattern; no Python needed since embeddings are out of scope, eliminating any cross-language IPC bridge |
| Filesystem watching | `chokidar` | Standard, reliable, event-driven |
| AST parsing | `web-tree-sitter` | Off-thread, per-language grammars, explicit memory cleanup |
| Terminal wrapping | `node-pty` | Standard PTY wrapper with backpressure support |
| Storage | SQLite (WAL mode), `better-sqlite3` | Zero-ops embedded database; WAL gives crash-safe concurrent reads/writes without a server process |
| CLI framework | `commander` | Standard, declarative command/flag definitions |
| Token counting | `gpt-tokenizer` | Fully local, no network call, keeps the offline guarantee intact |
| Network capture (opt-in) | `mockttp` (HTTPS interception) + `node-forge` (local CA) | Generalizes to any tool making outbound HTTPS calls, not just a browser tab — same technique as mitmproxy/Charles |
| MCP interface | `@modelcontextprotocol/sdk` | Official SDK; exposes the handoff manifest as an MCP resource over stdio |
| IPC | Unix Domain Socket (Linux/Mac), Named Pipe (Windows) | Standard local IPC, no network exposure |
| Process supervision | systemd (Linux), launchd (Mac) | Standard daemon auto-restart, no custom supervisor needed |
| Distribution | npm, package `steno-daemon` | Node.js is already the runtime; npm is the natural, zero-extra-packaging channel |
| License | MIT | Lowest friction for adoption; separate decision from contribution policy |
| Hosting | None — fully local | Zero cloud dependency is a hard architectural constraint, not a preference |

---

## 8. Why This Approach

To restate §2's table as the core differentiation: every serious alternative — Mem0, Zep, Letta, MemPalace, Supermemory, Cascade Memories, Cursor Notepads — is in-band. Stenod is the only one in this comparison set built around surviving the moment the AI itself is unreachable. That's a narrow, specific, defensible claim. It isn't "better memory"; it's a different failure-mode guarantee.

Being open source strengthens this claim in a way a closed-source competitor structurally can't match. The "zero network calls except an explicit AI-provider allowlist" promise is checkable by reading the code, rather than something a user has to take a vendor's word for.

---

## 9. Scope & Known Limitations

Deliberately out of scope for this version:

- Cross-file program-dependence-graph construction
- Multi-developer collaborative graph merging
- Adaptive/learned λ weight tuning (kept static and inspectable, by design)
- Full Windows terminal-capture support (`stenod attach` and the network tier are Unix/Mac only, since both depend on `node-pty` and OS trust-store operations)
- Any in-band LLM verification step (it would reintroduce the exact dependency this system exists to avoid)
- Certificate-pinned applications (invisible to the opt-in network tier)
- Embeddings/semantic fidelity scoring (deliberately never built; see §12 for what replaces it)
- Web dashboard / UI (CLI-only by design in this version)
- Live crash detection for bridged `stenod attach` sessions — only exit-code-driven success/failure is guaranteed there, not the stderr-shape heuristic, since the daemon receives only the final accumulated result at shell exit

---

## 10. Security, Privacy & Trust

- **Zero telemetry, hard invariant** — no phone-home, ever, and independently verifiable since the code is open.
- **Two-tier capture** exists specifically so installing this tool never requires trusting anything by default — the default tier needs no cert install and no proxy config.
- **Two-layer secret protection** — never watching secret-adjacent paths (primary, strongest), with regex redaction as a backstop (secondary, heuristic, and stated honestly as imperfect).
- **Auth on every local connection** — a rotateable token prevents any other local process from injecting fake graph events or reading captured traffic.
- **Full opt-out path** for the network tier, including CA removal — a trust ask needs an equally clear undo.

See [SECURITY.md](./SECURITY.md) for the plain-language account of exactly what is captured, where it's stored, and what the opt-in tier does and doesn't do.

---

## 11. Open Source Posture

- **License:** MIT.
- **Repo scaffolding:** README, LICENSE, SECURITY.md, and this document. There's no `CONTRIBUTING.md` and no active solicitation of external PRs at this stage — a deliberate early-stage stance. The license governs what others may legally do with the code; it says nothing about whether contributions are currently being reviewed. Contribution infrastructure can be added later without changing anything already built.
- **Distribution:** npm, package name `steno-daemon` (the CLI command itself is `stenod`).

---

## 12. Evaluation Strategy

No invented, unvalidated fidelity score. Two tiers, both honest:

1. **Native, cheap, deterministic:** exact-identifier recall — what fraction of function names, error codes, and variable names present in source nodes also appear verbatim in the compiled manifest. No ML, no embeddings, fully unit-testable.
2. **External credibility reference:** LoCoMo and LongMemEval are the benchmarks the field's actual memory systems (Mem0, Zep, MemPalace) report against. Adopting one of these published methodologies later is more credible than a bespoke score nobody outside the project can verify.

---

## 13. Cost

Fully free. Node.js, SQLite, `chokidar`, `node-pty`, `web-tree-sitter`, `gpt-tokenizer`, `mockttp`, and `node-forge` are all free, open-source packages. There's no hosted database, no vector DB service, and no cloud LLM calls during normal operation — that's the architecture's whole point. There is no per-user or per-install cost for anyone who runs the tool.

---

## 14. Design Decision Log

A record of the material corrections made during design, kept so a future contributor understands *why* things are the way they are, not just what they are.

| Issue | Resolution |
|---|---|
| Early spec claimed both a greedy compiler and an FPTAS DP as current | Greedy-by-ratio plus a local-improvement pass is the actual algorithm; the FPTAS is out of scope, not silently half-implemented |
| Storage spec disagreed on 2 vs. 4 tables | Settled on 3 — `graph_nodes`, `graph_edges`, `manifest_log`; other proposed tables cut as orthogonal scope |
| A semantic-embedding fidelity score was listed as both in-scope and unvalidated | Cut entirely; replaced with exact-identifier recall (native) plus a reference to LoCoMo/LongMemEval (external) |
| Conflict resolution described as both "implemented" and "doesn't exist yet" | Last-Writer-Wins built as a first-class mechanism |
| Rejection semantics disagreed (count-based vs. time-based) | Time-window based (`--since`), matching FSM session boundaries |
| Filesystem-diffing rollback verification proposed | Cut — redundant with git, which already answers "is this code actually gone" |
| Fabricated baseline numbers appeared in early research notes | Removed entirely; no unvalidated metrics appear in this document |
| Recency decay formula divided by zero at Δt=0 | Fixed to `1 / (1 + ln(1 + Δt))` |
| A rehearsal-probe step required an in-band LLM call | Cut — it directly contradicted the core "zero LLM dependency" claim |
| Capture mechanism couldn't see IDE-native AI chat panels, only browser tabs | Generalized to a local HTTPS interception proxy covering any tool making outbound HTTPS calls; the browser-extension-only design was fully superseded |
| HTTPS interception originally implied as default-on | Made strictly opt-in, since the tool ships to strangers, not just the author's machine |
| `manifest_log` referenced in delivery but never defined in storage | Table added |
| `PROVIDER_CAPTURE` node type had an undefined relationship to the FSM | Clarified: stored as content, does not drive FSM transitions |
| Daemon crash recovery present early, then silently dropped | Restored — systemd/launchd auto-restart via `stenod init` |
| No offline token-counting mechanism specified | Added — local tokenizer library, zero network calls |
| No filesystem ignore-list beyond a binary-size cap | Added — `.env`, `.git/`, `node_modules/`, build output dirs, `.gitignore`-respecting |
| No handling for long-running processes that never exit | Added — stderr crash-shape matching as an explicitly-labeled secondary heuristic |
| No schema migration story for users upgrading over time | Added — `PRAGMA user_version` plus a migration runner on `stenod start` |
| Packed manifest nodes carried only metadata, not real content | Fixed via tiered content inclusion (see §6.4); the manifest now carries actual resumable text |
| Terminal capture was built but never wired into the running daemon | Wired in via `stenod attach`, which bridges an interactive shell to the detached daemon over the token-authenticated local socket |
| Package name collided with npm's similarity checks | Published as `steno-daemon`; the CLI command remains `stenod` |
