# Stenod — WORKPLAN.md
**Status:** Canonical execution roadmap. Companion to `ARCHITECTURE.md`, which remains the source of truth for *why* every decision was made. This document governs *what gets built, in what order, and how each piece is proven correct.*

This is a living document. Update the status table as phases complete. It should always reflect real, current progress — not a plan frozen in time.

**A note on what changed here.** Stenod 1.0 (phases 0.1–14.3) is complete and Verified. Its full build specs — the original Build/Do NOT/Done when/Verify detail for each phase — have been retired from this document now that the work is shipped, tested, and stable; nobody needs to re-derive how to build a table that's been in production for months. What's kept is the **Master Status Tracker**, in full, including every verification note — that's the part with lasting value, since it's the record of what actually happened, including three real bugs implementation surfaced that no design review could have caught. If the original build-spec detail is ever needed, it's in git history. Everything from Milestone 15 onward is new, unbuilt, and gets the full spec treatment, same rigor as 1.0 originally had.

---

## How To Use This Document

**One phase per implementation pass. Never more.** This is the core anti-drift mechanism — an agent implementing five phases in one pass is exactly how scope creep and inconsistency enter a codebase. Small, verifiable, one at a time.

**Roles, per `AGENTS.md`:** Claude Code is the primary implementer — complex phases (capture internals, the interpretation cascade, storage schema, compiler logic) route there. Antigravity handles verification, documentation, and simple, well-scoped coding tasks; it does not implement complex phases. Whichever agent implements a given phase, the *other* one verifies it — that separation is the point, not a formality.

**Workflow:**
1. Pick the next `Not Started` phase from the status table (respect the `Depends on` column — never start a phase whose dependency isn't `Verified`).
2. If it's a complex phase, use the Claude Code prompt template below; if it's a simple/doc phase, Antigravity can implement directly using the same shape of prompt.
3. When the implementer reports done, bring the result to the *other* agent using the verification prompt template.
4. The verifier checks the output against that phase's "Done when" checklist and the relevant `ARCHITECTURE.md` section, reports PASS/FAIL per item, with fresh eyes.
5. Mark the phase `Verified` in the status table only after an explicit PASS. Only then start the next phase.

This is designed so a session reset costs nothing — reopen this file, find the last `Verified` phase, start the next one. No re-explaining.

### Implementer Prompt Template
```
Implement ONLY Phase [X.Y] — [Name] from WORKPLAN.md. Do not implement
any other phase, even if it seems related or convenient to do together.

Before writing code, read ARCHITECTURE.md §[ref] and this phase's full
entry in WORKPLAN.md.

Build exactly what "Build:" describes. Use exactly the libraries listed
in "Locked Technology Decisions" — do not substitute or add dependencies
not already listed there. Respect "Do NOT" exactly as written.

If anything here seems ambiguous, missing, or inconsistent with
ARCHITECTURE.md or AGENTS.md, stop and ask instead of guessing or
improvising a fix.

When finished, report each "Done when" item and how you verified it.
```

### Verifier Prompt Template
```
[Implementer] finished Phase [X.Y] — [Name]. Here's what it built:
[paste code / diff / test output / files]

Check this against Phase [X.Y]'s "Done when" checklist in WORKPLAN.md
and ARCHITECTURE.md §[ref]. Report PASS/FAIL per checklist item, and
flag anything that looks like drift from spec even if not explicitly
on the checklist.
```

### Execution Discipline (how to run this without stalling or drifting)

**Verification gates progress on the deterministic core, not on the implementer's ability to keep building.** The implementer can move through sequential phases without waiting for sign-off each time — mark each `Built (unverified)` in the status table as it's finished. What matters is that nothing gets marked `Verified` without an actual check from the other agent against that phase's checklist.

**Verify in dependency order, starting from the earliest `Built (unverified)` phase.** If that phase fails verification, stop — do not verify phases built after it. Anything built on top of an unverified-and-then-failed phase is suspect by construction, even if it looks correct in isolation. Fix and re-verify the failed phase first, then resume checking forward.

**Silent regression guard:** if a phase's implementation touches any file outside that phase's own listed scope — especially a file belonging to an already-`Verified` phase — treat that as a flag, not a bonus fix. Revert the earlier phase's status to unverified and re-check it before proceeding.

**Git discipline:** one commit per phase that reaches `Verified` status (not per `Built`), commit message referencing the phase number and name. This gives a clean, bisectable history and an exact rollback point if a later phase reveals an earlier one was subtly wrong.

**Resuming after a session gap:** if the original chat is still usable, stay in it. If not, open a new one, attach this file and `ARCHITECTURE.md`, and open with: *"Resuming Stenod. Check the Master Status Tracker — last Verified phase is [X.Y]. I need you to [verify the implementer's output for phase Y.Z / help me start phase Y.Z]."* These two documents exist specifically so that prompt is all a fresh session ever needs.

---

## Global Rules (apply to every phase, stated once here so they don't need repeating)

1. Read `ARCHITECTURE.md` in full before the first phase of any session; re-read the referenced section before each individual phase. Read `AGENTS.md` for the complete non-negotiable list — the ones most load-bearing for the new phases below are restated at the point they apply.
2. One phase per implementation pass. No exceptions for "it's quick" or "they're related."
3. Never invent tables, CLI commands, config options, or dependencies not already in `ARCHITECTURE.md` or this document. A gap is a reason to stop and ask, not to improvise.
4. Every phase that produces logic (not pure config/scaffolding) ships with tests in the same pass. A phase without passing tests is not done, regardless of what the code appears to do.
5. If a phase's own "Done when" checklist can't be fully satisfied, the phase is incomplete — report exactly which items failed, don't mark it done with caveats.
6. Determinism is a hard constraint throughout: same input state must always produce the same output. Anything that introduces randomness, wall-clock-dependent branching (beyond the explicit decay/timeout logic already specified), or unlisted external calls is out of bounds.
7. **New, for the 2.0 phases specifically:** a hook script must never block the tool it's watching (fire-and-forget, spool on daemon-down); never write to a tool's own rule/instruction files (read-and-flag only); the AI tie-breaker only ever runs on the user's own key, only at handoff time, never automatically; no Python or second runtime, under any argument; the companion dashboard is localhost-only, permanently, no exceptions.

---

## Locked Technology Decisions

Stated once here — phases reference this table rather than re-specifying, so there's one place a choice could ever drift from.

| Concern | Package | Verified version at planning time |
|---|---|---|
| SQLite driver | `better-sqlite3` | 12.11.1 |
| CLI framework | `commander` | 15.0.0 |
| Filesystem watching | `chokidar` | 5.0.0 |
| Terminal PTY | `node-pty` | 1.1.0 |
| Token counting | `gpt-tokenizer` | 3.4.0 |
| Test framework | `vitest` | 4.1.10 |
| Clipboard | `clipboardy` | 5.3.1 |
| Local HTTPS interception (opt-in tier) | `mockttp` | 4.4.2 |
| Certificate generation (opt-in tier) | `node-forge` | 1.4.0 |
| AST parsing | `web-tree-sitter` | 0.26.10 |
| JS/TS grammars | `tree-sitter-javascript`, `tree-sitter-typescript` | 0.25.0 / 0.23.2 |
| MCP server library | `@modelcontextprotocol/sdk` | 1.29.0 |
| Linting / formatting | `eslint` + `@typescript-eslint`, `prettier` | latest at implementation time |
| Deterministic text interpretation (Layer 1) | `wink-nlp` + its pinned language model package | verify current version at implementation time; pin both to a Node version confirmed in CI, since the model package version-locks to specific Node versions |
| Tier-C format parser (Cursor's undocumented chat storage) | not yet locked | pending the license/maintenance/footprint vetting specified in Phase 23.2 — do not add to this table until that phase completes |

All versions confirmed to exist on the npm registry at planning time (July 2026), except `wink-nlp`'s, which needs its own check. Re-verify current versions at implementation time — don't assume these exact patch versions are still current, just that these are the correct packages.

---

## Master Status Tracker

Update this table as work progresses. Status values: `Not Started`, `In Progress`, `Built (unverified)`, `Verified`, `Blocked`.

### Stenod 1.0 — complete, preserved as historical record

| # | Phase | Depends on | Status |
|---|---|---|---|
| 0.1 | Project init (Node/TS scaffold) | — | Verified |
| 0.2 | README + LICENSE | 0.1 | Verified |
| 0.3 | Test framework setup | 0.1 | Verified |
| 0.4 | Lint/format setup | 0.1 | Verified |
| 0.5 | CI pipeline (GitHub Actions) | 0.3, 0.4 | Verified |
| 1.1 | SQLite connection + WAL pragmas | 0.1 | Verified |
| 1.2 | `graph_nodes` table | 1.1 | Verified |
| 1.3 | `graph_edges` table | 1.1 | Verified |
| 1.4 | `manifest_log` table | 1.1 | Verified |
| 1.5 | Schema versioning / migration runner | 1.2, 1.3, 1.4 | Verified |
| 1.6 | Storage round-trip tests | 1.5 | Verified |
| 2.1 | Workspace sandboxing (`.stenod/`, PID lock) | 1.6 | Verified  |
| 2.2 | Local auth token (gen/store/rotate) | 2.1 | Verified  |
| 2.3 | IPC scaffold + token enforcement | 2.2 | Verified  |
| 3.1 | FSM state enum + transitions | 1.6 | Verified |
| 3.2 | Recency decay function (fixed formula) | 3.1 | Verified |
| 3.3 | LWW conflict resolution | 3.1 | Verified |
| 3.4 | Time-windowed rejection logic | 3.1 | Verified |
| 3.5 | Anti-rot timeout logic | 3.1 | Verified |
| 4.1 | chokidar watcher + ignore-list | 2.3, 3.1 | Verified — regression fixed (.stenod/ self-watch bug) |
| 4.2 | web-tree-sitter integration (JS/TS) | 4.1 | Verified |
| 4.3 | Constraint comment syntax parser | 4.2 | Verified |
| 4.4 | `FILE_STATE` node creation + graph write | 4.2, 3.1 | Verified |
| 4.5 | Secret redaction pass (filesystem) | 4.4 | Verified |
| 5.1 | node-pty shell wrapper | 2.3, 3.1 | Verified |
| 5.2 | 16ms batching + 64KB backpressure | 5.1 | Verified |
| 5.3 | Exit-code signal → node creation | 5.2, 3.1 | Verified |
| 5.4 | Long-running process stderr heuristic | 5.3 | Verified |
| 5.5 | Secret redaction pass (terminal) | 5.3 | Verified |
| 6.1 | Ingestion queue (the Bouncer) | 4.4, 5.3 | Verified |
| 6.2 | Backpressure/overflow disk-spill handling | 6.1 | Verified |
| 6.3 | Burst-load integration test | 6.2 | Verified |
| 7.1 | `stenod init` (sandbox + token + service unit) | 2.2 | Verified |
| 7.2 | `stenod start` / `stenod stop` | 6.3, 7.1 | Verified — re-verified post-Phase 7.5 regression guard; fs-only behavior unaffected, IPC server now also starts/stops correctly, no regression. Confirmed by Antigravity + CI #79 (445/445). |
| 7.3 | `stenod status` | 7.2 | Verified |
| 7.4 | Crash recovery validation | 7.2 | Blocked (Requires Unix host) |
| 7.5 | Wire terminal capture + IPC auth into the daemon | 7.2, 2.3, 5.3 | Verified — stenod attach bridges client-side PTY to daemon via IPC (final content+exitCode at shell exit only); ipc.ts onMessage hook confirmed additive-only; terminal-bridge.ts correctly bypasses createTerminalCapture(), calls writeTerminalNode() directly. Real CI #79 (ubuntu-latest): 61/61 files, 445/445 passed, including real simultaneous fs+terminal capture test and real (non-early-return) attach tests. Independently confirmed by Antigravity. Known limitations: Phase 5.4 heuristic doesn't fire for bridged sessions (documented); macOS behavior and real interactive-TTY UX remain manually unverified. |
| 8.1 | Token counting integration | 1.6 | Verified |
| 8.2 | Utility score calculation | 3.2 | Verified |
| 8.3 | Causal centrality (in/out-degree) | 1.6 | Verified |
| 8.4 | Greedy-by-ratio packing | 8.1, 8.2, 8.3 | Verified — re-verified post-Phase 8.10 regression guard; packing algorithm unchanged, PackableNode's new contentPreview field transported inertly. Confirmed by Antigravity cold review + Supervisor test run (411 passed, 2 skipped, 0 failed). |
| 8.5 | Local improvement pass | 8.4 | Verified — re-verified post-Phase 8.10 regression guard; swap logic inspects only utilityScore/tokenCost, unaffected by new field. |
| 8.6 | U-shaped output structuring | 8.5 | Verified — re-verified post-Phase 8.10 regression guard; zone ordering semantics unchanged. |
| 8.7 | "Next Actions" block generation | 8.6, 3.1 | Verified |
| 8.8 | Compiler correctness/determinism tests | 8.7 | Verified |
| 8.9 | DB-to-manifest orchestrator | 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7 | Verified — re-verified post-Phase 8.10; ORDER BY intact, CONSTRAINT force-inclusion intact, tiering logic (deriveContentPreview) confirmed correct, token_cost now derived from contentPreview not raw content. |
| 8.10 | Tiered content inclusion fix | 8.9 | Verified — three fixed tiers (CONSTRAINT full content, utilityScore>=0.6 bounded 300-token excerpt, else deterministic template) confirmed correct and non-configurable. src/mcp/server.test.ts assertion now passes for genuine reason (real content flows through). Confirmed by Antigravity cold review + Supervisor test run (411 passed, 2 skipped, 0 failed). |
| 9.1 | Clipboard delivery | 8.9 | Verified |
| 9.2 | `manifest_log` write on handoff | 9.1 | Verified |
| 9.3 | `--worked` / `--failed` feedback tagging | 9.2 | Verified |
| 10.1 | CLI framework setup + skeleton | 0.1 | Verified |
| 10.2 | Wire `stenod init` | 10.1, 7.1 | Verified |
| 10.3 | Wire `stenod start` / `stop` / `status` | 10.2, 7.3 | Verified |
| 10.4 | Wire `stenod handoff` (+worked/failed) | 10.3, 9.3 | Verified |
| 10.5 | Wire `stenod reject --since` | 10.4, 3.4 | Verified |
| 10.6 | Wire `stenod anchor` | 10.4 | Verified |
| 10.7 | Full end-to-end integration test | 10.6 | Verified — Gap 4 fixed at root cause, re-verified |
| 11.1 | Identifier extraction utility | 10.7 | Verified |
| 11.2 | Exact-identifier recall calculator | 11.1 | Verified |
| 11.3 | Dev-only evaluation harness script | 11.2 | Verified |
| 12.1 | Local CA generation + trust store install | 10.7 | Verified — Linux real NSS execution confirmed via CI #63 (commit c4405db) for install/verify, and CI #75 (commit 45da139) for the newer uninstall path (buildUninstallCommand/uninstallTrustStore, added for Phase 12.5). Both scratch-DB test suites pass for real on ubuntu-latest. macOS trust-store behavior (install, verify, and uninstall) remains unverified by any automated system in this pipeline (deliberate ubuntu-only CI design); manual verification on a real Mac deferred to Phase 12.5. |
| 12.2 | Local HTTPS proxy + provider allowlist | 12.1 | Verified — mockttp-based two-layer enforcement (TLS-layer tlsInterceptOnly + application-layer hostname check), verified via real CONNECT/TLS handshake tests, not plain HTTP. 3/3 new tests + full suite (398 passed, 2 skipped, 55/55 files) confirmed locally by Supervisor. Not yet wired into enable-network-capture (Phase 12.4). |
| 12.3 | SSE `.tee()` + `PROVIDER_CAPTURE` node creation | 12.2 | Verified — mockttp's own architecture supplies the tee (untouched `thenPassThrough` caller path + separate passive `response` event to the daemon, correlated against Phase 12.2's `getCapturedRequests()` allowlist record); proxy.ts untouched. 6/6 new tests (byte-identical passthrough via Buffer.equals(), PROVIDER_CAPTURE node creation scoped to allowlisted domains only, FSM-state-unchanged) + full src/network suite (26 passed, 2 skipped, 4/4 files) confirmed locally by Supervisor; independently cold-reviewed and cross-checked by Antigravity. |
| 12.4 | Wire `stenod enable-network-capture` | 12.3 | Verified — src/network/enable-capture.ts orchestrates 12.1 (generateRootCa/persistRootCa/installTrustStore) → 12.2 (createProviderCaptureProxy/start) → 12.3 (attachProviderCapture) in correct sequence with real types (no mismatches). Clear user explanation shown before acting. Fixed a genuine DB-connection-leak bug found during testing (try/catch closes DB + stops proxy on any failure). NOT wired into init/start. ca.ts/trust-store.ts/proxy.ts/provider-capture.ts confirmed untouched; program.ts changes confirmed additive only. Independently cross-reviewed by Antigravity (code-level PASS on all 6 checkable items, sandbox-limited on execution) + Supervisor's own local test run: 58/58 files, 416 passed, 2 skipped, 0 failed, src/cli/e2e.test.ts (Phase 10.7) individually reconfirmed passing. |
| 12.5 | Wire `stenod disable-network-capture` + uninstall test | 12.4 | Verified — disableNetworkCapture() correctly sequences uninstallTrustStore() → verifyTrustStoreInstall() (OS-level confirmation) → conditional rmSync of .stenod/ca/, only on confirmed removal (never discards the CA from disk unless the OS genuinely no longer trusts it). Fresh enable→disable→enable cycle test passes cleanly. ca.ts/proxy.ts/provider-capture.ts/enable-capture.ts confirmed untouched; program.ts additions confirmed additive only. vi.clearAllMocks() fix correctly present in this phase's own test file (Phase 12.4's test file still has the same latent gap, flagged for a future separate cleanup pass). Independently cold-reviewed by Antigravity (all 5 checkable items PASS) + Supervisor's own local run: 59 files, 426 passed, 3 skipped, 0 failed, including src/cli/disable-network-capture.test.ts (6/6) and src/cli/e2e.test.ts (Phase 10.7). |
| 13.1 | MCP resource exposure of handoff | 10.7 | Verified — src/mcp/server.ts exposes stenod://handoff/manifest via McpServer/StdioServerTransport, calling the real compileManifest() pipeline (Phase 8.9/8.10) and writeManifestLogEntry (Phase 9.2), not a stub. Clipboard delivery (Phase 9.1) confirmed byte-for-byte unchanged; program.ts's mcp command is purely additive. Manifest content confirmed genuine post-Phase 8.10 (CONSTRAINT node's real text verified present, not just metadata). @modelcontextprotocol/sdk correctly declared/used, pre-authorized in Locked Technology Decisions. Independently verified by Claude Code (roles reversed — Antigravity was implementer): all six checklist items PASS with direct code/test evidence, not self-report. Committed as 470c2db. |
| 14.1 | `SECURITY.md` | 12.5 | Verified — plain-language doc, all claims verified against real code (grep'd actual call sites, not comments). Correctly identifies stenod attach as the terminal-capture mechanism (post-7.5), IPC auth as genuinely active, and the Phase 5.4 heuristic gap for bridged sessions. Independently confirmed accurate by Antigravity. |
| 14.2 | Final README pass | 14.1 | Verified — full command reference matches src/cli/program.ts exactly. Walkthrough independently confirmed by Supervisor: real init → start → status → handoff sequence run in a fresh temp directory, all worked as documented. Pre-publish npm link note added after walkthrough revealed bare `stenod` command requires global install/link first. CI #82 green. |
| 14.3 | npm publish dry-run + package.json review | 14.2 | Verified — fixed a real packaging leak (397 files/1.6MB → 133 files/125.0kB): added package.json "files" allowlist + tsconfig.json test exclusion, removing all source .ts, test files, WORKPLAN.md/ARCHITECTURE.md/CLAUDE.md, and dev tooling from the shipped package. Verified via full suite (442 passed, 3 skipped), npm pack + extract + fresh install + running the CLI (--version, --help) from the extracted tarball alone. CI #81 green. |

66 phases total, all Verified except the one host-blocked item. Deliberately granular enough that no phase required more than one clear judgment call, and coarse enough that "one phase" still meant "one real, testable unit of the system."

### Stenod 2.0 — the multi-tool expansion, in progress

| # | Phase | Depends on | Status |
|---|---|---|---|
| 15.1 | Claude Code hook payload spike | 14.3 | Verified |
| 15.2 | Antigravity brain-folder spike | 14.3 | Not Started |
| 16.1 | `DECISION` node type + `resolution`/`resolution_reason` columns | 15.1, 15.2 | Not Started |
| 16.2 | `source_tool`/`git_branch` columns + `SHADOWED` status + `RESOLVES` edge type | 16.1 | Not Started |
| 16.3 | Migration + backfill + round-trip tests | 16.2 | Not Started |
| 17.1 | Hook-script router (per-project resolution) | 16.3 | Not Started |
| 17.2 | `stenod integrate` / `stenod detach` CLI commands | 17.1 | Not Started |
| 18.1 | `wink-nlp` integration | 16.3 | Not Started |
| 18.2 | Layer 1 deterministic rule pass | 18.1 | Not Started |
| 18.3 | Topic-identity matching ladder | 18.2 | Not Started |
| 18.4 | `DECISION` node creation wired to Layer 0 | 16.3, 3.1, 3.3 | Not Started |
| 18.5 | Layer 2 optional AI tie-breaker client | 18.3 | Not Started |
| 18.6 | Interpretation cascade integration test | 18.4, 18.5 | Not Started |
| 19.1 | Claude Code hook receiver | 17.2, 18.6, 15.1 | Not Started |
| 19.2 | `PreCompact` snapshot handling | 19.1 | Not Started |
| 19.3 | Claude Code integration end-to-end test | 19.2 | Not Started |
| 20.1 | Codex hook receiver | 17.2, 18.6 | Not Started |
| 20.2 | Codex integration end-to-end test | 20.1 | Not Started |
| 21.1 | Kiro hook receiver | 17.2, 18.6 | Not Started |
| 21.2 | Kiro spec-file reader (`requirements.md`/`design.md`/`tasks.md`) | 21.1 | Not Started |
| 21.3 | Kiro integration end-to-end test | 21.2 | Not Started |
| 22.1 | Antigravity auxiliary watch-path registration | 17.2, 15.2 | Not Started |
| 22.2 | Conversation-to-project matching | 22.1 | Not Started |
| 22.3 | Brain-folder reader | 22.2, 18.6 | Not Started |
| 22.4 | Antigravity integration end-to-end test | 22.3 | Not Started |
| 23.1 | Cursor agent hook receiver | 17.2, 18.6 | Not Started |
| 23.2 | Vet and lock a Tier-C parser for Cursor's chat storage | 23.1 | Not Started |
| 23.3 | Tier-C adapter wrapper | 23.2 | Not Started |
| 23.4 | Cursor integration end-to-end test | 23.1, 23.3 | Not Started |
| 24.1 | `source_tool` provenance retrofit (4.x/5.x + 19–23) | 19.3, 20.2, 21.3, 22.4, 23.4 | Not Started |
| 24.2 | Reasoning-to-file-event pinning | 24.1 | Not Started |
| 24.3 | Double-capture shadowing | 24.1 | Not Started |
| 24.4 | Same-file/same-second collision flagging | 24.2 | Not Started |
| 24.5 | Cross-tool merge integration test | 24.3, 24.4 | Not Started |
| 25.1 | Dependency-manifest watcher | 16.3, 4.1 | Not Started |
| 25.2 | Dependency `DECISION` node creation | 25.1, 18.4 | Not Started |
| 26.1 | Rule-file reader + scoreboard comparison | 18.4 | Not Started |
| 26.2 | Persistent, event-driven flag surfacing | 26.1 | Not Started |
| 27.1 | `--full` / `--new` handoff flags | 24.5 | Not Started |
| 27.2 | Rejection one-liner tiering (extends 8.10) | 27.1, 8.10 | Not Started |
| 27.3 | Default-to-`--full` + `--new` hint line | 27.2 | Not Started |
| 28.1 | Extend recall calculator to multi-tool capture | 24.5, 11.2 | Not Started |
| 29.1 | Antigravity cross-verification of the 2.0 reference docs | 27.3 | Not Started |

---

## Milestone 15 — Capture-Surface Spike

Per `AGENTS.md`'s Verification section: this milestone is validation only, and every capture phase from Milestone 19 onward cites its output rather than the assumptions made during design. If real payloads carry less reasoning text than assumed, later phases recalibrate — the interpretation cascade already degrades safely (more falls to Layer 1, or to `OPEN`).

#### Phase 15.1 — Claude Code Hook Payload Spike
- **Depends on:** 14.3
- **ARCHITECTURE ref:** §7.1
- **Build:** on a throwaway project, wire the minimal set of Claude Code hooks (`SessionStart`, `PostToolUse`, `PreCompact`, `Stop`) to append their full, raw JSON payload to a local file — no parsing, no daemon integration, just capture the ground truth. Run a realistic ~20-minute session: make a decision, reject an approach mid-way, run a failing then a passing command, and try to trigger a compaction.
- **Do NOT:** wire this into the actual daemon or write any production capture code — this phase produces a reference document, not shipped code.
- **Done when:**
  - [x] Real payloads captured for all four hook events
  - [x] Written answer to: how much of the assistant's own reasoning text rides along in each event, if any
  - [x] Written answer to: does `PreCompact` deliver actual pre-compaction content, or only a signal that compaction is about to happen
  - [x] Written answer to: what session/timestamp/branch metadata is actually present in each payload
- **Verify:** review the captured payload samples directly against the four questions above.

**Findings:**
- SessionStart: thin — session_id, transcript_path, cwd, source ("startup" | "compact"), model. No reasoning content.
- PostToolUse: full tool_input + tool_response, including raw Bash stdout/stderr. Real signal.
- Stop: includes last_assistant_message (full text of Claude's final reply). No user-side prompt text.
- PreCompact: signal-only — trigger ("manual"|"auto") + custom_instructions. No transcript/context payload.
- No git_branch field in any event — confirms §7.2 fallback (read .git/HEAD directly) is required, not optional.
- GAP: no hook payload contains the user's own prompt text, in any event. Only Claude's output
  (Stop) and tool activity (PostToolUse) are captured. User intent is only recoverable by
  separately parsing transcript_path (JSONL). Any design assuming hooks alone capture
  full conversational context is wrong — flag against ARCHITECTURE.md before build phases
  that depend on this.

#### Phase 15.2 — Antigravity Brain-Folder Spike
- **Depends on:** 14.3
- **ARCHITECTURE ref:** §7.1
- **Build:** run a comparable session in Google Antigravity on a throwaway project, then inspect the resulting `~/.gemini/antigravity/brain/<conversation-id>/` folder directly — the JSONL transcript and the markdown artifacts (`implementation_plan.md`, `task.md`, `walkthrough.md`).
- **Done when:**
  - [ ] Written answer to: what does the JSONL transcript actually contain, and how does it map to a real session's events
  - [ ] Written answer to: how much of a decision's reasoning appears in the markdown artifacts versus the transcript
  - [ ] Written answer to: what identifies which project a given brain-folder conversation belongs to
- **Verify:** review the captured folder contents directly against the three questions above. Consolidate 15.1 and 15.2's findings into `docs/spike-capture-surfaces.md`, the reference every later capture phase cites.

---

## Milestone 16 — Schema v2 Extension

#### Phase 16.1 — `DECISION` Node Type + Resolution Fields
- **Depends on:** 15.1, 15.2
- **ARCHITECTURE ref:** §7.2
- **Build:** extend `graph_nodes.type` to include `DECISION`, alongside the existing five values. Add `resolution` (ENUM, nullable: `SETTLED`/`REJECTED`/`OPEN`) and `resolution_reason` (TEXT, nullable). `resolution_reason` must be non-null whenever `resolution = REJECTED`, enforced at the application layer.
- **Do NOT:** touch `status`'s existing enum in this phase — that's 16.2.
- **Done when:**
  - [ ] `DECISION` nodes can be created with all three resolution states
  - [ ] A `REJECTED` decision without a reason is rejected by the write path
  - [ ] Existing node types and their behavior are completely unaffected
- **Verify:** unit test creating one `DECISION` node per resolution state, plus a rejected-without-reason failure case.

#### Phase 16.2 — Provenance Columns + `SHADOWED` Status + `RESOLVES` Edge
- **Depends on:** 16.1
- **ARCHITECTURE ref:** §7.2
- **Build:** add `source_tool` (TEXT, non-null, defaulting per capture path) and `git_branch` (TEXT, nullable) to `graph_nodes`. Add `SHADOWED` to `status`'s enum, alongside `ACTIVE`/`REJECTED`/`SUPERSEDED`. Add `RESOLVES` to `graph_edges.edge_type`'s enum, alongside the existing four.
- **Done when:**
  - [ ] All four new/extended fields insert and query correctly
  - [ ] A `SHADOWED` node is excluded from any query already filtering to `status = 'ACTIVE'` — no query-site changes needed, confirming the filter was written generically
- **Verify:** unit test inserting nodes across all `source_tool`/`status` combinations, confirm existing `ACTIVE`-only queries correctly exclude `SHADOWED`.

#### Phase 16.3 — Migration + Backfill + Round-Trip Tests
- **Depends on:** 16.2
- **ARCHITECTURE ref:** §7.2
- **Build:** a `PRAGMA user_version` migration adding all of 16.1/16.2's columns to an existing 1.0 database. Old rows get `source_tool` backfilled from a best-guess mapping of their existing `type` (e.g. `FILE_STATE` → `fs`, `TERMINAL_*` → `terminal`); everything else defaults to null.
- **Do NOT:** rewrite or delete any existing row's `id`, `content`, or other 1.0-era data — additive only.
- **Done when:**
  - [ ] Migration runs cleanly against a real 1.0-era database fixture
  - [ ] Backfilled `source_tool` values match the expected mapping for every 1.0 node type
  - [ ] Migration is idempotent — running it twice doesn't double-apply or error
- **Verify:** integration test against a seeded 1.0-shaped fixture DB, run the migration twice, confirm final state matches expected on both runs.

---

## Milestone 17 — Tool Integration Infrastructure

#### Phase 17.1 — Hook-Script Router
- **Depends on:** 16.3
- **ARCHITECTURE ref:** §7.1
- **Build:** the router logic every tool-specific hook script (Milestones 19–23) will call into. Given an event's working directory, resolve upward looking for a `.stenod/` directory. If found, hand the event to that project's daemon over the token-authenticated socket (or spool locally if unreachable) and exit `0` immediately. If not found, exit `0` immediately without capturing or sending anything.
- **Do NOT:** implement any tool-specific payload parsing here — this phase is the routing/delivery mechanism only, shared by every tool.
- **Done when:**
  - [ ] A working-directory match correctly resolves to the right project's daemon
  - [ ] No match exits cleanly with zero side effects
  - [ ] The script never blocks: a simulated unreachable daemon still results in immediate exit, with the event spooled locally
- **Verify:** unit tests for match/no-match cases, plus an integration test simulating a daemon-down scenario, confirming the spool file receives the event and the calling process is never blocked.

#### Phase 17.2 — `stenod integrate` / `stenod detach` CLI Commands
- **Depends on:** 17.1
- **ARCHITECTURE ref:** §7.1, §6
- **Build:** `stenod integrate <tool>` writes Stenod's hook entries into that tool's configuration file additively — never removing or modifying existing entries — and prints exactly what it wrote and where. `stenod detach <tool>` removes exactly those entries, then re-reads the file to confirm removal, mirroring `disable-network-capture`'s (Phase 12.5) confirmed-clean-undo pattern exactly.
- **Do NOT:** run either command automatically from `init` or `start`. Do NOT touch any configuration entry Stenod didn't itself add.
- **Done when:**
  - [ ] `integrate` on a fixture config file adds only Stenod's own entries, confirmed by diff
  - [ ] `detach` removes exactly those entries and confirms removal by re-reading the file
  - [ ] Running `integrate` twice doesn't duplicate entries
  - [ ] A config file with pre-existing, unrelated entries is completely unaffected beyond the addition/removal
- **Verify:** fixture-file test for both commands, including the pre-existing-entries-untouched case.

---

## Milestone 18 — Interpretation Cascade

#### Phase 18.1 — `wink-nlp` Integration
- **Depends on:** 16.3
- **ARCHITECTURE ref:** §7.3
- **Build:** add `wink-nlp` and its pinned language model package (per the Locked Technology Decisions table) as a dependency. Build a thin wrapper module exposing sentence splitting, tokenization, and negation detection — the primitives Layer 1 needs — rather than calling the library directly from interpretation logic.
- **Done when:**
  - [ ] Sentence splitting and negation detection produce correct results on fixture sentences, including at least one negation-scope edge case
  - [ ] The wrapper module has no dependents yet outside its own tests — this phase is the library integration, not the rule pass
- **Verify:** unit tests against a fixture set of sentences, including plain, negated, and multi-clause cases.

#### Phase 18.2 — Layer 1 Deterministic Rule Pass
- **Depends on:** 18.1
- **ARCHITECTURE ref:** §7.3
- **Build:** using 18.1's primitives, detect explicit rejection language ("instead of", "let's not", "reverting"), decision language ("we'll use", "settled on"), and reuse the existing constraint comment syntax (Phase 4.3). A match produces a candidate `resolution` and `resolution_reason`; no match means this layer abstains — it must never guess.
- **Do NOT:** call any AI/network service from this phase — purely deterministic.
- **Done when:**
  - [ ] Fixture sentences with clear rejection/decision language are correctly classified
  - [ ] A genuinely ambiguous fixture sentence correctly abstains (produces no verdict) rather than guessing
- **Verify:** unit test suite covering clear-positive, clear-negative, and ambiguous-abstain cases.

#### Phase 18.3 — Topic-Identity Matching Ladder
- **Depends on:** 18.2
- **ARCHITECTURE ref:** §7.3
- **Build:** the three-rung ladder from `ARCHITECTURE.md` §7.3: an explicit `constraint[key]` match wins outright; failing that, look for shared identifiers, a shared `source_file`, or explicit referential language ("instead of X"); failing that, leave both entries active and raise a `POSSIBLE_CONFLICT` marker rather than merging or duplicating silently.
- **Done when:**
  - [ ] An explicit key match correctly supersedes
  - [ ] A deterministic-inference match (shared file, shared identifier) correctly supersedes
  - [ ] A genuinely unclear pair produces a `POSSIBLE_CONFLICT` marker, and both nodes remain active
- **Verify:** unit test for all three rungs of the ladder, including the flagged-not-guessed case.

#### Phase 18.4 — `DECISION` Node Creation Wired to Layer 0
- **Depends on:** 16.3, 3.1, 3.3
- **ARCHITECTURE ref:** §7.3
- **Build:** wire the existing FSM and Last-Writer-Wins machinery (Phases 3.1, 3.3) against the new `DECISION` node type — a file overwrite superseding an earlier decision, or a failing-then-passing command sequence, should produce a correctly-resolved `DECISION` node without invoking Layer 1 or Layer 2 at all.
- **Do NOT:** modify the FSM or LWW logic itself — this phase reuses it against a new node type, it doesn't change how either works.
- **Done when:**
  - [ ] A fixture structural sequence (file overwrite, or fail-then-pass command) produces a correctly-resolved `DECISION` node using only Layer 0
  - [ ] No Layer 1/Layer 2 code is invoked for these cases
- **Verify:** integration test asserting the resolution is correct and that Layer 1/2 code paths are never called for a purely structural fixture.

#### Phase 18.5 — Layer 2 Optional AI Tie-Breaker Client
- **Depends on:** 18.3
- **ARCHITECTURE ref:** §7.3
- **Build:** a client that, when a user-supplied API key is configured, sends only the ambiguous span plus minimal surrounding context (never the full transcript) to resolve a `POSSIBLE_CONFLICT` or an unresolved decision, only when explicitly invoked at handoff time. Without a key configured, this layer must be a complete no-op — the item simply stays `OPEN`.
- **Do NOT:** call this layer automatically, on any schedule, or from anywhere other than an explicit handoff request. Do NOT send anything beyond the single ambiguous span and minimal context.
- **Done when:**
  - [ ] With no key configured, ambiguous items correctly remain `OPEN` and no network call is attempted
  - [ ] With a key configured, a fixture ambiguous case is correctly resolved via a real call, sending only the expected minimal payload (verified via request inspection, not just a mocked response)
  - [ ] This layer is never invoked outside of an explicit handoff call
- **Verify:** unit test for the no-key no-op case; integration test with a real or recorded API call confirming payload size/content is the minimal span, not the full graph.

#### Phase 18.6 — Interpretation Cascade Integration Test
- **Depends on:** 18.4, 18.5
- **ARCHITECTURE ref:** §7.3
- **Build:** one comprehensive test exercising all three layers together against a realistic mixed fixture — some purely structural decisions, some clear-text decisions, some genuinely ambiguous ones — confirming the correct layer resolves each case and layers are tried in the correct cost order (0, then 1, then 2 only if configured).
- **Done when:**
  - [ ] The full cascade produces correct results across a mixed fixture, with each case resolved at the cheapest layer capable of resolving it
  - [ ] Running the cascade twice on identical input produces identical output (determinism holds even with the optional Layer 2, given a fixed/recorded response)
- **Verify:** run the integration test, inspect which layer resolved each fixture case, confirm it's the cheapest capable one.

---

## Milestone 19 — Tier-A Capture: Claude Code

#### Phase 19.1 — Claude Code Hook Receiver
- **Depends on:** 17.2, 18.6, 15.1
- **ARCHITECTURE ref:** §7.1
- **Build:** using Phase 15.1's confirmed payload shapes, build the receiver that turns real `SessionStart`/`PostToolUse`/`Stop` hook payloads into graph nodes via the router (17.1) and the interpretation cascade (18.x), tagged `source_tool = 'claude-code'`.
- **Do NOT:** invent payload fields not confirmed present in Phase 15.1's findings — if something assumed during design turns out absent, note it and adjust, don't fabricate.
- **Done when:**
  - [ ] Real hook payloads (from a live or recorded Claude Code session) produce correctly-typed, correctly-tagged nodes
  - [ ] `git_branch` is correctly populated when present in the payload
- **Verify:** integration test using either a live Claude Code session or a recorded fixture payload set from Phase 15.1.

#### Phase 19.2 — `PreCompact` Snapshot Handling
- **Depends on:** 19.1
- **ARCHITECTURE ref:** §7.1
- **Build:** per Phase 15.1's confirmed findings on what `PreCompact` actually delivers, implement the snapshot behavior — capturing the clean pre-compaction state at that exact moment, delta-only against the last snapshot (not a full re-dump), per the locked design.
- **Done when:**
  - [ ] A `PreCompact` event correctly triggers a snapshot containing only what's changed since the last one
  - [ ] Behavior matches what Phase 15.1 actually confirmed `PreCompact` delivers — if it turns out to be signal-only rather than content-bearing, this phase implements the best-effort fallback documented in that spike, not the originally-assumed ideal case
- **Verify:** integration test simulating a `PreCompact` event, confirming snapshot content matches expectations set by 15.1's findings.

#### Phase 19.3 — Claude Code Integration End-to-End Test
- **Depends on:** 19.2
- **ARCHITECTURE ref:** §7.1
- **Build:** one comprehensive test: `stenod integrate claude-code`, run a realistic session with a decision, a rejection, a compaction trigger, confirm the resulting graph state is correct start to finish.
- **Done when:**
  - [ ] This single test passes, proving the full Claude Code capture path works end to end
- **Verify:** run the test, manually review the resulting graph nodes against what the simulated session should have produced.

---

## Milestone 20 — Tier-A Capture: Codex

#### Phase 20.1 — Codex Hook Receiver
- **Depends on:** 17.2, 18.6
- **ARCHITECTURE ref:** §7.1
- **Build:** same shape as Phase 19.1, targeting Codex's hook set (`PreToolUse`, `PostToolUse`, `PreCompact`/`PostCompact`, `SessionStart`, `Stop`), tagged `source_tool = 'codex'`. Codex's hooks closely mirror Claude Code's, so this phase should largely reuse 19.1's structure rather than reinvent it — flag anything that doesn't map cleanly rather than forcing it.
- **Done when:**
  - [ ] Real or recorded Codex hook payloads produce correctly-typed, correctly-tagged nodes
- **Verify:** integration test using a live or recorded Codex session.

#### Phase 20.2 — Codex Integration End-to-End Test
- **Depends on:** 20.1
- **ARCHITECTURE ref:** §7.1
- **Build:** same shape as Phase 19.3, for Codex.
- **Done when:**
  - [ ] This single test passes, proving the full Codex capture path works end to end
- **Verify:** run the test, manually review resulting graph nodes.

---

## Milestone 21 — Tier-A Capture: Kiro

#### Phase 21.1 — Kiro Hook Receiver
- **Depends on:** 17.2, 18.6
- **ARCHITECTURE ref:** §7.1
- **Build:** same shape as Phase 19.1, targeting Kiro's hook set (`.kiro/hooks/` event triggers), tagged `source_tool = 'kiro'`.
- **Done when:**
  - [ ] Real or recorded Kiro hook payloads produce correctly-typed, correctly-tagged nodes
- **Verify:** integration test using a live or recorded Kiro session.

#### Phase 21.2 — Kiro Spec-File Reader
- **Depends on:** 21.1
- **ARCHITECTURE ref:** §7.1
- **Build:** a reader for Kiro's own `requirements.md`, `design.md`, and `tasks.md` files, extracting decisions and open items already structured by the tool itself, feeding them into the interpretation cascade the same as any other reasoning source.
- **Done when:**
  - [ ] A fixture set of Kiro spec files produces correctly-typed decision/open nodes
- **Verify:** unit test against fixture spec files.

#### Phase 21.3 — Kiro Integration End-to-End Test
- **Depends on:** 21.2
- **ARCHITECTURE ref:** §7.1
- **Build:** same shape as Phase 19.3, for Kiro, including both the hook path and the spec-file path.
- **Done when:**
  - [ ] This single test passes, proving the full Kiro capture path works end to end
- **Verify:** run the test, manually review resulting graph nodes.

---

## Milestone 22 — Tier-B Capture: Google Antigravity

#### Phase 22.1 — Auxiliary Watch-Path Registration
- **Depends on:** 17.2, 15.2
- **ARCHITECTURE ref:** §7.1
- **Build:** `stenod integrate antigravity` registers `~/.gemini/antigravity/brain/` as an auxiliary watch path tied to the current project, distinct from the project-root-only watching every other capture path uses.
- **Done when:**
  - [ ] Registration correctly persists the auxiliary path association for the project
  - [ ] `stenod detach antigravity` correctly removes it
- **Verify:** unit test for register/detach.

#### Phase 22.2 — Conversation-to-Project Matching
- **Depends on:** 22.1
- **ARCHITECTURE ref:** §7.1
- **Build:** per Phase 15.2's confirmed findings on what identifies a conversation's project, implement matching logic — a conversation folder whose contents reference this project's workspace path is captured; anything that doesn't match confidently is left alone, never guessed at.
- **Done when:**
  - [ ] A fixture conversation folder referencing the current project is correctly matched
  - [ ] A fixture folder referencing a different project is correctly skipped
- **Verify:** unit test with both matching and non-matching fixture folders.

#### Phase 22.3 — Brain-Folder Reader
- **Depends on:** 22.2, 18.6
- **ARCHITECTURE ref:** §7.1
- **Build:** reads the JSONL transcript and markdown artifacts from a matched conversation folder, feeding content into the interpretation cascade, tagged `source_tool = 'antigravity'`.
- **Done when:**
  - [ ] A fixture brain folder produces correctly-typed, correctly-tagged nodes from both the transcript and the markdown artifacts
- **Verify:** integration test against a fixture brain folder (real or recorded from Phase 15.2).

#### Phase 22.4 — Antigravity Integration End-to-End Test
- **Depends on:** 22.3
- **ARCHITECTURE ref:** §7.1
- **Build:** one comprehensive test: `stenod integrate antigravity`, run or simulate a session, confirm resulting graph state is correct — including the specific case of Antigravity's own history UI failing to show something that Stenod correctly captured anyway.
- **Done when:**
  - [ ] This single test passes, proving the full Antigravity capture path works end to end
- **Verify:** run the test, manually review resulting graph nodes.

---

## Milestone 23 — Tier-C Capture: Cursor

#### Phase 23.1 — Cursor Agent Hook Receiver
- **Depends on:** 17.2, 18.6
- **ARCHITECTURE ref:** §7.1
- **Build:** same shape as Phase 19.1, targeting Cursor's agent-level hook system for tool calls and file edits (not its human-facing chat storage — that's 23.2/23.3), tagged `source_tool = 'cursor'`.
- **Done when:**
  - [ ] Real or recorded Cursor agent hook payloads produce correctly-typed, correctly-tagged nodes
- **Verify:** integration test using a live or recorded Cursor session.

#### Phase 23.2 — Vet and Lock a Tier-C Parser
- **Depends on:** 23.1
- **ARCHITECTURE ref:** §8
- **Build:** evaluate available open-source parsers for Cursor's undocumented chat-history storage against license (must be permissive), maintenance activity (is it keeping pace with Cursor's own format changes), and dependency footprint. Document the evaluation and the chosen package. Add it to the Locked Technology Decisions table only once this phase completes.
- **Do NOT:** add any candidate to the Locked Technology Decisions table before this phase's evaluation is done and documented.
- **Done when:**
  - [ ] A written comparison of at least two candidates against the three criteria exists
  - [ ] A package is chosen and its rationale documented
  - [ ] The Locked Technology Decisions table is updated with the real package name and version
- **Verify:** review the written evaluation and the updated table entry.

#### Phase 23.3 — Tier-C Adapter Wrapper
- **Depends on:** 23.2
- **ARCHITECTURE ref:** §7.1
- **Build:** a thin adapter module wrapping the chosen parser from 23.2 — the rest of the codebase talks to the adapter's own interface, never to the borrowed parser's types directly, per `AGENTS.md`'s module-boundary rule. Includes a guarded-read pattern: a schema mismatch degrades to a missing field, not a crash.
- **Done when:**
  - [ ] A fixture Cursor storage file produces correctly-typed nodes through the adapter
  - [ ] A deliberately malformed/unexpected-shape fixture degrades gracefully (missing field, not an exception) rather than crashing
- **Verify:** unit test for both the normal-parse and malformed-input cases.

#### Phase 23.4 — Cursor Integration End-to-End Test
- **Depends on:** 23.1, 23.3
- **ARCHITECTURE ref:** §7.1
- **Build:** one comprehensive test covering both the agent-hook path (23.1) and the Tier-C chat-storage path (23.3) together.
- **Done when:**
  - [ ] This single test passes, proving both Cursor capture paths work end to end
- **Verify:** run the test, manually review resulting graph nodes.

---

## Milestone 24 — Cross-Tool Merge & Deduplication

#### Phase 24.1 — `source_tool` Provenance Retrofit
- **Depends on:** 19.3, 20.2, 21.3, 22.4, 23.4
- **ARCHITECTURE ref:** §7.2
- **Build:** confirm every capture path — including the original 1.0 filesystem (4.x) and terminal (5.x) tracks — correctly tags `source_tool` (`fs`, `terminal`, or the specific tool). 1.0's tracks likely need a small, additive change to populate this field, since it didn't exist when they were built.
- **Do NOT:** modify any other behavior of the 4.x/5.x tracks — this is a tagging-only retrofit.
- **Done when:**
  - [ ] Every node created by any capture path, old or new, carries a correct `source_tool` value
  - [ ] 1.0's existing tests still pass unmodified, confirming no behavioral regression
- **Verify:** re-run the full 1.0 test suite plus new tagging-specific assertions.

#### Phase 24.2 — Reasoning-to-File-Event Pinning
- **Depends on:** 24.1
- **ARCHITECTURE ref:** §7.4
- **Build:** the filesystem-as-backbone merge logic — a reasoning node is matched to the file event it explains by which file it references first, falling back to timestamp only as a tiebreaker. Reasoning with no file reference yet becomes/stays `OPEN` until a file event arrives to anchor it.
- **Done when:**
  - [ ] A fixture reasoning node referencing a specific file correctly pins to that file's event
  - [ ] A fixture reasoning node with no file reference correctly stays `OPEN`
  - [ ] A later file event correctly resolves a previously-`OPEN` reasoning node that references it
- **Verify:** unit tests for all three cases.

#### Phase 24.3 — Double-Capture Shadowing
- **Depends on:** 24.1
- **ARCHITECTURE ref:** §7.2
- **Build:** detect when a hook event and a terminal-track event describe the same occurrence (matching on command text and overlapping time window, within the same session) and mark the terminal-track copy `SHADOWED`. Where a confident match can't be made, both stay active.
- **Done when:**
  - [ ] A fixture pair of matching hook/terminal events correctly results in one `ACTIVE` node and one `SHADOWED` node
  - [ ] A fixture pair that shouldn't match (different commands, no time overlap) correctly leaves both `ACTIVE`
  - [ ] The compiler (Phase 8.4's packing query) correctly excludes `SHADOWED` nodes without any change to the packing logic itself
- **Verify:** unit tests for match/no-match cases, plus confirmation that existing `ACTIVE`-only packing queries need no modification.

#### Phase 24.4 — Same-File/Same-Second Collision Flagging
- **Depends on:** 24.2
- **ARCHITECTURE ref:** §7.4
- **Build:** when two `DECISION` nodes from different tools reference the same file within the same second with contradictory `resolution`, apply LWW as normal but also raise a flagged, contested-entry marker for the user rather than silently resolving it as a clean supersession.
- **Done when:**
  - [ ] A fixture same-file, same-second, contradictory pair correctly applies LWW ordering *and* raises the contested-entry flag
  - [ ] A fixture same-file collision with non-contradictory content does not raise the flag
- **Verify:** unit tests for both cases.

#### Phase 24.5 — Cross-Tool Merge Integration Test
- **Depends on:** 24.3, 24.4
- **ARCHITECTURE ref:** §7.4
- **Build:** one comprehensive test simulating your actual target scenario — two or three tools acting on one project concurrently (a file write from one, a test run from another, overlapping in time) — confirming the merged graph is correctly ordered, deduplicated, and flagged where appropriate.
- **Done when:**
  - [ ] This single test passes, proving the cross-tool merge behaves correctly under realistic concurrent activity
- **Verify:** run the test, manually review the resulting merged graph against what the simulated concurrent session should produce.

---

## Milestone 25 — Dependency-Change Capture

#### Phase 25.1 — Dependency-Manifest Watcher
- **Depends on:** 16.3, 4.1
- **ARCHITECTURE ref:** §7.1
- **Build:** extend the existing chokidar watcher (Phase 4.1) to specifically watch `package.json`, `requirements.txt`, and `Cargo.toml`, and correlate changes with the exit codes of install commands from the terminal track (Phase 5.3) — never reading installed package contents (`node_modules/`, etc.) directly.
- **Do NOT:** watch or read anything inside `node_modules/` or equivalent installed-package directories.
- **Done when:**
  - [ ] A fixture manifest-file change is correctly detected and distinguished from an ordinary source-file save
  - [ ] Correlation with a following install command's exit code works on a fixture sequence
- **Verify:** integration test simulating a manifest edit followed by an install command.

#### Phase 25.2 — Dependency `DECISION` Node Creation
- **Depends on:** 25.1, 18.4
- **ARCHITECTURE ref:** §7.1
- **Build:** turn a detected dependency addition, removal, or swap into a `DECISION` node (settled for an addition, rejected-with-reason for a removed dependency where a prior addition exists to supersede).
- **Done when:**
  - [ ] A fixture "add package X" produces a correctly-typed settled `DECISION`
  - [ ] A fixture "remove package X, add package Y" produces X marked rejected (superseded by Y) and Y marked settled
- **Verify:** unit test for both fixture cases.

---

## Milestone 26 — Stale Rule-File Detection

#### Phase 26.1 — Rule-File Reader + Scoreboard Comparison
- **Depends on:** 18.4
- **ARCHITECTURE ref:** §7.5
- **Build:** a reader for a tool's own instruction files (`CLAUDE.md`, `.cursor/rules`, and similar), comparing claims found there against the current scoreboard's settled decisions, producing a mismatch record where they conflict. Read-only — this phase must never write to any file it reads.
- **Do NOT:** write to any rule/instruction file under any circumstance, including for testing convenience — use fixture copies, never the real files.
- **Done when:**
  - [ ] A fixture rule file matching the current scoreboard produces no mismatch
  - [ ] A fixture rule file contradicting a settled decision produces a correctly-described mismatch
  - [ ] No write operation of any kind occurs against the rule file during either test
- **Verify:** unit tests for both cases, plus an explicit assertion (e.g. a read-only file permission in the test fixture) that no write was attempted.

#### Phase 26.2 — Persistent, Event-Driven Flag Surfacing
- **Depends on:** 26.1
- **ARCHITECTURE ref:** §7.5
- **Build:** surface a detected mismatch at the three specified moments — `handoff`, `status`, and the instant a new decision creates a fresh contradiction — and keep it visible until the underlying rule file actually changes. Never surface on a timer.
- **Done when:**
  - [ ] A mismatch appears in `handoff` and `status` output
  - [ ] A mismatch appears immediately when a new contradicting decision is recorded
  - [ ] A resolved mismatch (rule file updated) correctly stops appearing
  - [ ] No polling/timer-based surfacing exists anywhere in this phase's code
- **Verify:** integration test covering appearance at all three trigger points and disappearance on resolution.

---

## Milestone 27 — Two-View Handoff Compilation

#### Phase 27.1 — `--full` / `--new` Handoff Flags
- **Depends on:** 24.5
- **ARCHITECTURE ref:** §7.5
- **Build:** `--full` compiles the complete standing scoreboard (every settled decision, every rejected one with its reason); `--new` compiles only what's changed since the timestamp of the previous `manifest_log` entry. Both run the same conflict resolution — a superseded decision never appears as live in either view.
- **Done when:**
  - [ ] `--full` on a fixture graph produces the complete current scoreboard
  - [ ] `--new` on the same fixture, with a prior `manifest_log` entry, produces only the delta since that entry
  - [ ] Neither flag ever includes a `SUPERSEDED` node as if it were `ACTIVE`
- **Verify:** unit tests for both flags against a fixture graph with a mix of settled/rejected/superseded/new content.

#### Phase 27.2 — Rejection One-Liner Tiering
- **Depends on:** 27.1, 8.10
- **ARCHITECTURE ref:** §7.5
- **Build:** extend Phase 8.10's existing tiered content inclusion so every rejected `DECISION` node — regardless of its utility score — always appears in `--full` output, but as a one-line "what was rejected, and why" summary rather than a full excerpt, so a large rejection history doesn't bloat the manifest.
- **Do NOT:** exclude any rejected decision from `--full` output — all of them appear, per the locked design; only their *content tier* changes.
- **Done when:**
  - [ ] Every rejected `DECISION` node in a fixture graph appears in `--full` output
  - [ ] Each appears as a one-line summary, not full content, regardless of its utility score
  - [ ] A fixture graph with a large number of rejected nodes produces a manifest that stays within a reasonable token range, not scaling linearly with full-content inclusion
- **Verify:** unit test confirming full coverage plus tiering; a token-count assertion on a fixture with many rejections.

#### Phase 27.3 — Default-to-`--full` + `--new` Hint Line
- **Depends on:** 27.2
- **ARCHITECTURE ref:** §7.5
- **Build:** the bare `stenod handoff` (no flag) behaves as `--full`, with a line appended below the output pointing to `--new` for the leaner option.
- **Done when:**
  - [ ] `stenod handoff` with no flag produces identical output to `stenod handoff --full`
  - [ ] The hint line appears and correctly references `--new`
- **Verify:** CLI invocation test comparing flagless output to explicit `--full` output.

---

## Milestone 28 — Evaluation Harness Update

#### Phase 28.1 — Extend Recall Calculator to Multi-Tool Capture
- **Depends on:** 24.5, 11.2
- **ARCHITECTURE ref:** §14
- **Build:** extend Phase 11.2's exact-identifier recall calculator to run against nodes tagged with any `source_tool`, not only `fs`/`terminal` — confirming the metric still means what it's supposed to mean once hook- and artifact-sourced content is in the mix.
- **Done when:**
  - [ ] Recall calculation on a mixed-source fixture graph produces correct results across all `source_tool` values
- **Verify:** unit test with a fixture graph mixing 1.0-era and 2.0-era node sources.

---

## Milestone 29 — 2.0 Documentation Reconciliation

#### Phase 29.1 — Antigravity Cross-Verification of the 2.0 Reference Docs
- **Depends on:** 27.3
- **ARCHITECTURE ref:** whole document
- **Build:** no new code. Antigravity reads `ARCHITECTURE.md`, `SECURITY.md`, `README.md`, `AGENTS.md`, `CLAUDE.md`, and `ANTIGRAVITY.md` together in one pass and checks them against each other and against the actual shipped 2.0 codebase at this point — flagging any claim that's gone stale (a described-but-not-yet-built feature that's now built and behaves differently, a command that changed shape, a limitation that's been resolved).
- **Done when:**
  - [ ] Each of the six documents is confirmed consistent with the others
  - [ ] Each is confirmed accurate against the real, shipped 2.0 code — not aspirational
  - [ ] Any drift found is listed explicitly, with the specific file and claim, not summarized away
- **Verify:** review the cross-check report directly; resolve any flagged drift before considering 2.0's documentation complete.