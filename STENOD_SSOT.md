# Stenod — Single Source of Truth (SSOT)

**Status:** Final and canonical. Supersedes MNEMOSYNE_V1_SPEC.md and MNEMOSYNE_MASTER_ARCHITECTURE.md in full. No further ideation document should be needed after this one — corrections happen as edits to this file, not new documents.

**Naming note:** originally conceived as "Mnemosyne." Renamed to **Stenod** after naming research found a genuine brand/product collision with an existing "Mnemosyne Neural OS" ecosystem in the same problem space — not merely an npm registry conflict. All CLI commands, directory names, and package names in this document use the new name. "Stenod" (from *stenographer* — someone who silently, exactly transcribes what happens, for someone else to read later) also happens to read naturally as a Unix daemon name (`stenod`, in the tradition of `sshd`, `httpd`).

---

## 1. The Problem

**Precise statement:** AI-assisted coding sessions collapse at boundaries — rate limits, provider outages, context-window exhaustion, or a developer deliberately switching tools mid-task. What's lost at that moment isn't just chat history; it's the *reasoning*: which architectural decisions were made and why, which approaches were tried and rejected, which constraints are still active, and what the developer was mid-way through doing.

This is not hypothetical. Windsurf's move to quota-based billing in March 2026 caused real, documented user backlash specifically because developers got mid-session rate-limited and lost flow. The pain is current, not speculative.

**What existing tools save:** conversations.
**What actually gets lost:** the intent behind the conversation.

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

**The pattern:** every serious alternative is in-band — it shares a failure domain with the thing it's trying to help. None of them are built specifically around the moment the AI itself is unreachable.

---

## 3. Introducing Stenod

Stenod is a local, deterministic, out-of-band daemon that captures the causal history of a coding session — file changes, terminal outcomes, and (optionally) AI-provider network traffic — and compiles it into an attention-structured Handoff Manifest the moment a developer needs to resume in any AI tool, including one they weren't previously using.

**The one sentence that matters:** *not a better memory service — a system that doesn't share a failure domain with the AI it's recording.*

It is not pitched as "the first AI memory system" — that space is crowded and well-funded, as §2 shows plainly. It is a precisely-scoped tool solving one real, underserved failure mode.

---

## 4. Complete Feature List

- **Two-tier capture:** zero-trust default (filesystem + terminal), explicit opt-in for AI-provider network capture
- **Causal graph storage** with typed edges (`REPLACES`, `CAUSED_BY`, `CONTRADICTS`, `DEPENDS_ON`) instead of a vector store
- **FSM-based intent classification** — distinguishes deliberate architectural decisions from panic fixes by state-transition pattern, not keyword heuristics
- **Last-Writer-Wins conflict resolution** — contradicting constraints are automatically resolved, not both silently injected into a future manifest
- **Deterministic compiler** — greedy-by-ratio knapsack packing plus a local-improvement pass, with a forced primacy zone for constraints
- **U-shaped manifest structuring** — exploits transformer primacy/recency attention bias, citation-backed (Liu et al. *Lost in the Middle*, Xiao et al. *Attention Sinks*)
- **"Next Actions" block** — surfaces the FSM's current unresolved state as an explicit next step, not just raw context
- **Manifest audit log** — every compiled handoff is logged with its exact node selection, queryable and auditable
- **Feedback tagging** (`--worked` / `--failed`) — the only mechanism for ever having real data to justify tuning retrieval weights later
- **Time-windowed rejection** (`--since <duration>`) — prune a bad session's nodes from all future manifests
- **Secret protection, two layers** — never watching secret-adjacent paths at all (primary), regex redaction as a backstop (secondary)
- **Clean opt-in/opt-out** for the network capture tier, including full CA-cert removal
- **Daemon crash recovery** via systemd/launchd auto-restart
- **Schema versioning** for safe upgrades across releases
- **Zero telemetry** — independently verifiable, since the project is open source

---

## 5. Interfaces

**CLI (the only interface — no web dashboard in this version, a deliberate scope choice, not a placeholder):**

| Command | Purpose |
|---|---|
| `stenod init` | Set up daemon + DB for a project directory, generate local auth token, install systemd/launchd unit |
| `stenod start` | Start the ingestion daemon (default tier: filesystem + terminal) |
| `stenod stop` | Stop the daemon |
| `stenod status` | Daemon health, node count, last event timestamp |
| `stenod handoff` | Compile and copy the Handoff Manifest to clipboard |
| `stenod handoff --worked` / `--failed` | Tag the outcome of the most recent manifest in the audit log |
| `stenod reject --since <duration>` | Mark nodes in a time window as `REJECTED`, excluded from all future manifests |
| `stenod anchor "<text>"` | Create a `CONSTRAINT` node directly from the CLI |
| `stenod enable-network-capture` | Opt in to the AI-provider network capture tier (installs local CA, starts proxy) |
| `stenod disable-network-capture` | Fully revert the CA trust and proxy settings |

**Optional convenience interface:** `stenod handoff` also exposed as an MCP resource/tool, so an already-reachable agent can pull the manifest directly rather than requiring a copy-paste. This is additive convenience only — the system must always degrade gracefully to clipboard-only.

---

## 6. System Architecture — How Every Part Works

### 6.1 Capture Layer

**Default tier (zero trust required):**
- **Filesystem:** `chokidar` watches the project directory; on save, content is parsed by `web-tree-sitter` in a background thread (AST parse under ~10ms; explicit `tree.delete()`/`parser.delete()` in `finally` blocks prevents memory leaks). Excludes: `.env`, `.git/`, `node_modules/`, common build output dirs, anything the project's own `.gitignore` already excludes, and binaries over 500KB.
- **Terminal:** `node-pty` wraps the developer's shell, batching output at 16ms intervals, 64KB backpressure high-water mark (overflow spills to a temp file, stream pauses, resumes after flush). Success/failure signal is the **shell exit code** for commands that terminate — language-agnostic, doesn't depend on matching test-runner-specific output strings. Long-running processes that never exit within a session (dev servers, `docker compose up`) are additionally watched for stderr matching common crash shapes (`Error:`, `Traceback`, `panic:`, unhandled rejection patterns) as an explicitly-labeled best-effort secondary signal, since exit-code detection doesn't apply to them.

**Opt-in tier (`stenod enable-network-capture`):**
- A local HTTPS interception proxy — not a per-IDE integration — since AI providers are reached over HTTPS regardless of which surface (browser tab, Cursor, Windsurf, Antigravity) initiates the call. This single mechanism is what a separate Chrome extension and separate "IDE integration" would have had to duplicate; it replaces both.
- Generates a local root CA, installed into the OS trust store only when this command is explicitly run — never silently.
- Routes traffic via `HTTP_PROXY`/`HTTPS_PROXY`, **allowlisting known AI provider domains only** (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, etc.) — everything else passes through untouched and unlogged. This allowlist is plain, readable code, independently verifiable by anyone who installs the tool.
- SSE/streaming responses are `.tee()`'d: one stream continues to the caller unmodified, the other feeds the daemon.
- Known, stated limitation: certificate-pinned applications will refuse the local CA and won't be visible, even with this tier enabled.
- `stenod disable-network-capture` fully reverts the CA and proxy settings — a trust ask needs an equally clear undo path.

**Ingestion queue ("the Bouncer"):** all tracks feed one serialized queue into WAL-SQLite. Shared max in-flight depth; overflow spills to an append-only disk buffer, drained FIFO, never silently dropped. Target write latency under 5ms, zero `SQLITE_BUSY` errors.

**Security baseline:** every local socket/proxy connection requires a token generated at `stenod init`, stored in `.stenod/token`, rotated via `stenod init --reset`.

**Workspace sandboxing:** one daemon per resolved project root, DB at `<project>/.stenod/graph.db`, PID lock file prevents a second daemon attaching to the same root.

**Daemon crash recovery:** `stenod init` generates a systemd user unit (Linux) or launchd plist (Mac) with `Restart=on-failure`.

### 6.2 Storage Layer — Causal Graph (three tables)

**Why a typed-edge graph, not a vector store:** vector similarity clusters "use MongoDB" and "switch to PostgreSQL" together because they're semantically close — exactly wrong for a system whose job is knowing which one is *still true*. (This insight isn't unique to Stenod — Zep's Graphiti applies similar temporal-graph thinking to conversational facts. The distinction here is scope — developer/codebase causal events, not chat facts — and mechanism: out-of-band capture, zero API dependency at read time.)

**`graph_nodes`**
| column | type | notes |
|---|---|---|
| `id` | TEXT (PK) | SHA-256 of content |
| `event_id` | INTEGER | monotonic, for WAL crash recovery ordering |
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

`PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-64000`. Schema version tracked via `PRAGMA user_version`; `stenod start` runs pending migrations before attaching.

**Constraint syntax:** `// VCS: constraint[key]=value` (or the equivalent per-language comment syntax), recognized wherever tree-sitter identifies a comment node — language-agnostic since it matches comment text, not code structure.

**Language scope:** tree-sitter grammars for JavaScript/TypeScript at launch, matching the tool's own stack. Additional grammars are a natural, well-bounded category of future contribution — tree-sitter grammars are modular by design.

### 6.3 Lifecycle, Conflict Resolution, Decay

**FSM:** `IDE_IDLE → RUNTIME_ERR` (stderr/nonzero exit) `→ DOC_EDIT` (save) `→ DIFF_SUBMIT` (commit). A direct `RUNTIME_ERR → DIFF_SUBMIT` skip is tagged `PROVISIONAL_PANIC`, excluded from manifests unless explicitly anchored.

`PROVIDER_CAPTURE` nodes are stored as content but do **not** drive FSM transitions — transitions stay driven exclusively by terminal exit codes and file saves, the two unambiguous ground-truth signals. Classifying intent from AI conversation text would reintroduce exactly the kind of content heuristic the FSM exists to avoid.

**Recency decay (bug found and fixed during design review):** original formula `1/ln(1+Δt)` is undefined at Δt=0 (new node → ln(1)=0 → division by zero). Corrected:
```
decay(Δt) = 1 / (1 + ln(1 + Δt_seconds))
```
Monotonic, no singularity, decay(0) = 1.

**Conflict resolution (Last-Writer-Wins, built in):** a new `CONSTRAINT` node sharing a `constraint_key` with an `ACTIVE` constraint draws a `CONTRADICTS` edge to it and flips the old node to `SUPERSEDED`. The compiler excludes anything not `ACTIVE`, unconditionally.

**Rejection:** `stenod reject --since 15m` — time-windowed to match FSM session boundaries, not arbitrary node counts. A pure graph-metadata operation (`status = REJECTED`); verifying deletion from the filesystem is git's job, not this system's — rebuilding version control would be redundant.

**Anti-rot:** FSM stuck in `RUNTIME_ERR` for τ > 600s → seal the active tree, apply decay.

### 6.4 Compilation Engine

Utility score per node: `v_i = λ1·decay(Δt) + λ2·causal_centrality + λ3·constraint_priority`, with static constants `λ1=0.4, λ2=0.4, λ3=0.2` — fixed, not learned, consistent with the whole system's determinism principle. `causal_centrality` is simple in/out-degree within the node's own edge set — cheap, O(V+E), sufficient at realistic single-project graph sizes.

**A precision point worth documenting clearly, since it's easy to get wrong:** Dantzig's greedy-by-ratio is provably optimal for the *fractional* knapsack problem — it carries **no formal optimality guarantee for 0/1 knapsack**, which is what node selection actually is (a node is either in the manifest or not). The algorithm:

1. Traverse graph, drop anything `status != ACTIVE`.
2. Force-include all `CONSTRAINT` nodes → primacy zone, regardless of score.
3. Sort remaining nodes by `v_i / token_cost` descending.
4. Pack until the token budget is hit.
5. **Local improvement pass:** for the lowest-value included node, check whether swapping it for the highest-value excluded node that still fits improves total value. Repeat until no improving swap exists.

This is a standard, cheap heuristic upgrade to plain greedy — no O(n²·1/ε) DP matrix needed. If a *proven* optimality bound is ever needed, that's the honest reason to build the DP, not because greedy is "wrong" as-is.

**Token counting:** a local, offline tokenizer library (e.g. `gpt-tokenizer`) measures `token_cost` per node — zero network calls, consistent with the offline guarantee.

**Output structure (U-shaped):** constraints (primacy zone) → packed causal graph (middle) → exact resume instruction plus the "Next Actions" block, derived from the FSM's current unresolved state (recency zone).

### 6.5 Delivery

Clipboard copy is the guaranteed path — zero dependency on anything being reachable, the entire point of the project. The optional MCP exposure is convenience only, and must degrade gracefully to clipboard-only if unavailable. Every compiled manifest is logged (`manifest_log`) before delivery.

---

## 7. Complete Tech Stack & Rationale

| Component | Choice | Why |
|---|---|---|
| Runtime | Node.js / TypeScript, single process | Event-loop concurrency model matches the high-frequency I/O capture pattern; no Python needed since embeddings are out of scope entirely, which also eliminates any cross-language IPC bridge |
| Filesystem watching | `chokidar` | Standard, reliable, event-driven |
| AST parsing | `web-tree-sitter` | Off-thread, per-language grammars, explicit memory cleanup |
| Terminal wrapping | `node-pty` | Standard PTY wrapper with backpressure support |
| Storage | SQLite3, WAL mode | Zero-ops embedded database; WAL gives crash-safe concurrent reads/writes without a server process |
| Token counting | `gpt-tokenizer` (or equivalent offline tokenizer) | Fully local, no network call, keeps the offline guarantee intact |
| Network capture (opt-in) | Local HTTPS interception proxy + local CA | Generalizes to any tool making outbound HTTPS calls, not just a browser tab — same technique as mitmproxy/Charles |
| IPC | Unix Domain Socket (Linux/Mac), Named Pipe (Windows) | Standard local IPC, no network exposure |
| Process supervision | systemd (Linux), launchd (Mac) | Standard daemon auto-restart, no custom supervisor needed |
| Distribution | npm, unscoped package `stenod` | Node.js is already the runtime; npm is the natural, zero-extra-packaging channel; name confirmed available |
| License | MIT | Lowest friction for adoption; separate decision from contribution policy |
| Hosting | None — fully local | Zero cloud dependency is a hard architectural constraint, not a preference |

---

## 8. Why This Approach Is Superior — Grounded Comparison

Restating §2's table as the core differentiation: every serious alternative — Mem0, Zep, Letta, MemPalace, Supermemory, Cascade Memories, Cursor Notepads — is in-band. Stenod is the only one in this comparison set built specifically around surviving the moment the AI itself is unreachable. That is a narrow, specific, honestly-defensible claim — not "better memory," a different failure-mode guarantee entirely.

Being open source strengthens this specific claim in a way a closed-source competitor structurally cannot match: the "zero network calls except an explicit AI-provider allowlist" promise is independently checkable by reading the code, not something a user has to trust a vendor about.

---

## 9. Explicitly Out of Scope / Known Limitations

- Cross-file program-dependence-graph construction
- Multi-developer collaborative graph merging
- Adaptive/learned λ weight tuning (kept static and inspectable, by design)
- Full Windows ConPTY validation (Unix/Mac only for now)
- Any in-band LLM verification step (would reintroduce the exact dependency this system exists to avoid)
- Certificate-pinned applications (invisible to the opt-in network tier)
- Embeddings/semantic fidelity scoring (BGE-M3-style Φ scoring) — deliberately never built; see §12 for what replaces it
- Web dashboard / UI — CLI-only by design in this version

---

## 10. Security, Privacy & Trust Posture

- **Zero telemetry, hard invariant** — no phone-home, ever, and independently verifiable since the code is open.
- **Two-tier capture** exists specifically so installing this tool never requires trusting anything by default — the default tier needs no cert install, no proxy config.
- **Two-layer secret protection** — never watching secret-adjacent paths (primary, strongest), regex redaction as a backstop (secondary, heuristic, stated honestly as imperfect).
- **Auth on every local connection** — a rotateable token prevents any other local process from injecting fake graph events or reading captured traffic.
- **Full opt-out path** for the network tier, including CA removal — a trust ask needs an equally clear undo.
- A plain-language `SECURITY.md` should state exactly what is captured, where it's stored (always local), and precisely what the opt-in tier does and doesn't do.

---

## 11. Open Source Posture

- **License:** MIT.
- **Repo scaffolding, for now: README + LICENSE only.** No `CONTRIBUTING.md`, no active solicitation of external PRs at this stage. This is a deliberate, common early-stage stance — the license governs what others may legally do with the code; it says nothing about whether contributions are currently being reviewed. Contribution infrastructure can be added later without changing anything already built.
- **Distribution:** npm, unscoped package name `stenod`.
- **Naming history, briefly, for anyone who asks:** originally "Mnemosyne"; renamed after discovering a real product-level collision with an existing "Mnemosyne Neural OS" ecosystem, not just an npm slot conflict.

---

## 12. Evaluation Strategy

No invented, unvalidated fidelity score with fabricated baseline numbers. Two-tier, both honest:

1. **Native, cheap, deterministic (build this):** exact-identifier recall — what fraction of function names, error codes, and variable names present in source nodes also appear verbatim in the compiled manifest. No ML, no embeddings, fully unit-testable.
2. **External credibility reference, cite rather than reinvent:** LoCoMo and LongMemEval are the benchmarks the field's actual memory systems (Mem0, Zep, MemPalace) report against. Adopting one of these published methodologies later is more credible than a bespoke score nobody outside the project can verify.

---

## 13. Cost to Build and Run

Fully free. Node.js, SQLite, `chokidar`, `node-pty`, `web-tree-sitter`, `gpt-tokenizer` are all free, open-source packages. No hosted database, no vector DB service, no cloud LLM calls during normal operation — that's the architecture's whole point. There is no per-user or per-install cost for anyone who runs this tool.

---

## 14. Appendix — Design Decision Log (for traceability)

A record of every material correction made during design, kept here so an AI coding agent or future contributor understands *why* things are the way they are, not just what they are.

| Issue found | Resolution |
|---|---|
| v1 spec claimed both greedy compiler and FPTAS DP as current | Greedy-by-ratio + local improvement pass is the actual algorithm; FPTAS is out of scope, not silently half-implemented |
| Storage spec disagreed on 2 vs. 4 tables | 3 tables — `graph_nodes`, `graph_edges`, `manifest_log`. `task_backlog`/`system_states` cut as orthogonal scope |
| BGE-M3/Φ scoring listed as both in-scope and "hypothesis, not run" in the same document | Cut entirely; replaced with exact-identifier recall (native) + reference to LoCoMo/LongMemEval (external) |
| Conflict resolution described as both "already implemented" and "doesn't exist yet" | Last-Writer-Wins implemented as a first-class mechanism |
| `mnemo reject` semantics disagreed (count-based vs. time-based) | Time-window based (`--since`), matches FSM session boundaries |
| Shadow Rollback Verification (filesystem diffing) proposed | Cut — redundant with git, which already solves "is this code actually gone" |
| Fabricated Φ baseline numbers (0.31/0.54/0.72/0.99) appeared in research | Removed entirely; never appear in this document |
| Recency decay formula divided by zero at Δt=0 | Fixed to `1/(1+ln(1+Δt))` |
| Causal Rehearsal Probe required an in-band LLM call | Cut — directly contradicted the project's core "zero LLM dependency" claim |
| Capture mechanism couldn't see IDE-native AI chat panels (only browser tabs) | Generalized to a local HTTPS interception proxy covering any tool making outbound HTTPS calls; Chrome-extension-only design fully superseded, along with its MV3 service-worker lifecycle problem |
| HTTPS interception originally implied as default | Made strictly opt-in, given this ships to strangers, not just the author's machine |
| `manifest_log` referenced in the delivery section but never defined in storage | Table added |
| `PROVIDER_CAPTURE` node type had an undefined relationship to the FSM | Clarified: stored as content, does not drive FSM transitions |
| Daemon crash recovery present in early research, silently dropped during unification | Restored — systemd/launchd auto-restart via `stenod init` |
| No offline token-counting mechanism ever specified | Added — local tokenizer library, zero network calls |
| No filesystem ignore-list beyond ">500KB binary" | Added — `.env`, `.git/`, `node_modules/`, build output dirs, `.gitignore`-respecting |
| No handling specified for long-running processes that never exit | Added — stderr crash-shape matching as an explicitly-labeled secondary heuristic |
| No schema migration story for users upgrading over time | Added — `PRAGMA user_version` + migration runner on `stenod start` |
| CLI/package name never checked against real registries | Checked live: `mnemo`/`mnemosyne` taken (unrelated, low-activity); deeper research found a genuine product collision (Mnemosyne Neural OS) — project renamed to **Stenod**, confirmed available |
| Phase 8.8's determinism test covered only the in-memory packing pipeline (8.4–8.7), correctly per each phase's own scope — but no Milestone 8 phase ever specified building the DB-to-pipeline orchestrator, leaving genuine end-to-end determinism (including SQLite fetch ordering) untested | Added Phase 8.9 (DB-to-manifest orchestrator) with an explicit `ORDER BY` requirement; Phase 9.1's dependency updated from 8.8 to 8.9 |