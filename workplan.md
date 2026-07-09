# Stenod — WORKPLAN.md
**Status:** Canonical execution roadmap. Companion to `STENOD_SSOT.md`, which remains the source of truth for *why* every decision was made. This document governs *what gets built, in what order, and how each piece is proven correct.*

This is a living document. Update the status table as phases complete. It should always reflect real, current progress — not a plan frozen in time.

---

## How To Use This Document

**One phase per Antigravity request. Never more.** This is the core anti-drift mechanism — a model implementing five phases in one pass is exactly how scope creep and inconsistency enter a codebase. Small, verifiable, one at a time.

**Workflow:**
1. Pick the next `Not Started` phase from the status table (respect the `Depends on` column — never start a phase whose dependency isn't `Verified`).
2. Copy the **Antigravity prompt template** below, fill in the phase number, paste it into Antigravity along with the phase's full entry from this document.
3. When Antigravity reports done, bring the result to Claude using the **verification prompt template** below.
4. Claude checks the output against that phase's "Done when" checklist and `STENOD_SSOT.md` section, reports PASS/FAIL per item.
5. Mark the phase `Verified` in the status table only after an explicit PASS. Only then start the next phase.

This is designed so a session reset costs nothing — reopen this file, find the last `Verified` phase, start the next one. No re-explaining.

### Antigravity Prompt Template
```
Implement ONLY Phase [X.Y] — [Name] from WORKPLAN.md. Do not implement
any other phase, even if it seems related or convenient to do together.

Before writing code, read STENOD_SSOT.md §[ref] and this phase's full
entry in WORKPLAN.md.

Build exactly what "Build:" describes. Use exactly the libraries listed
in "Locked Technology Decisions" — do not substitute or add dependencies
not already listed there. Respect "Do NOT" exactly as written.

If anything here seems ambiguous, missing, or inconsistent with the SSOT,
stop and ask instead of guessing or improvising a fix.

When finished, report each "Done when" item and how you verified it.
```

### Claude Verification Prompt Template
```
Antigravity finished Phase [X.Y] — [Name]. Here's what it built:
[paste code / diff / test output / files]

Check this against Phase [X.Y]'s "Done when" checklist in WORKPLAN.md
and STENOD_SSOT.md §[ref]. Report PASS/FAIL per checklist item, and
flag anything that looks like drift from spec even if not explicitly
on the checklist.
```

### Execution Discipline (how to run this without stalling or drifting)

**Verification gates progress on the deterministic core, not on Antigravity's ability to keep building.** Antigravity can move through sequential phases without waiting for Claude's sign-off each time — mark each `Built (unverified)` in the status table as it's finished. What matters is that nothing gets marked `Verified` without an actual Claude check against that phase's checklist.

**When Claude is available again, verify in dependency order starting from the earliest `Built (unverified)` phase.** If that phase fails verification, stop — do not verify phases built after it. Anything built on top of an unverified-and-then-failed phase is suspect by construction, even if it looks correct in isolation. Fix and re-verify the failed phase first, then resume checking forward.

**Silent regression guard:** if a phase's implementation touches any file outside that phase's own listed scope — especially a file belonging to an already-`Verified` phase — treat that as a flag, not a bonus fix. Revert the earlier phase's status to unverified and re-check it before proceeding.

**Git discipline:** one commit per phase that reaches `Verified` status (not per `Built`), commit message referencing the phase number and name. This gives a clean, bisectable history and an exact rollback point if a later phase reveals an earlier one was subtly wrong.

**Resuming after a session gap:** if the original chat is still usable, stay in it. If not, open a new one, attach this file and `STENOD_SSOT.md`, and open with: *"Resuming Stenod. Check the Master Status Tracker — last Verified phase is [X.Y]. I need you to [verify Antigravity's output for phase Y.Z / help me start phase Y.Z]."* These two documents exist specifically so that prompt is all a fresh session ever needs.

---

## Global Rules (apply to every phase, stated once here so they don't need repeating)

1. Read `STENOD_SSOT.md` in full before the first phase of any session; re-read the referenced section before each individual phase.
2. One phase per implementation pass. No exceptions for "it's quick" or "they're related."
3. Never invent tables, CLI commands, config options, or dependencies not already in the SSOT or this document. A gap is a reason to stop and ask, not to improvise.
4. Every phase that produces logic (not pure config/scaffolding) ships with tests in the same pass. A phase without passing tests is not done, regardless of what the code appears to do.
5. If a phase's own "Done when" checklist can't be fully satisfied, the phase is incomplete — report exactly which items failed, don't mark it done with caveats.
6. Determinism is a hard constraint throughout: same input state must always produce the same output. Anything that introduces randomness, wall-clock-dependent branching (beyond the explicit decay/timeout logic already specified), or unlisted external calls is out of bounds.

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
| Linting / formatting | `eslint` + `@typescript-eslint`, `prettier` | latest at implementation time |

All versions confirmed to exist on the npm registry at planning time (July 2026). Re-verify current versions at implementation time — don't assume these exact patch versions are still current, just that these are the correct packages.

---

## Master Status Tracker

Update this table as work progresses. Status values: `Not Started`, `In Progress`, `Built (unverified)`, `Verified`.

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
| 4.1 | chokidar watcher + ignore-list | 2.3, 3.1 | Verified |
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
| 7.2 | `stenod start` / `stenod stop` | 6.3, 7.1 | Verified |
| 7.3 | `stenod status` | 7.2 | Verified |
| 7.4 | Crash recovery validation | 7.2 | Blocked (Requires Unix host) |
| 8.1 | Token counting integration | 1.6 | Verified |
| 8.2 | Utility score calculation | 3.2 | Verified |
| 8.3 | Causal centrality (in/out-degree) | 1.6 | Verified |
| 8.4 | Greedy-by-ratio packing | 8.1, 8.2, 8.3 | Verified |
| 8.5 | Local improvement pass | 8.4 | Verified |
| 8.6 | U-shaped output structuring | 8.5 | Built (unverified) |
| 8.7 | "Next Actions" block generation | 8.6, 3.1 | Not Started |
| 8.8 | Compiler correctness/determinism tests | 8.7 | Not Started |
| 9.1 | Clipboard delivery | 8.8 | Not Started |
| 9.2 | `manifest_log` write on handoff | 9.1 | Not Started |
| 9.3 | `--worked` / `--failed` feedback tagging | 9.2 | Not Started |
| 10.1 | CLI framework setup + skeleton | 0.1 | Not Started |
| 10.2 | Wire `stenod init` | 10.1, 7.1 | Not Started |
| 10.3 | Wire `stenod start` / `stop` / `status` | 10.2, 7.3 | Not Started |
| 10.4 | Wire `stenod handoff` (+worked/failed) | 10.3, 9.3 | Not Started |
| 10.5 | Wire `stenod reject --since` | 10.4, 3.4 | Not Started |
| 10.6 | Wire `stenod anchor` | 10.4 | Not Started |
| 10.7 | Full end-to-end integration test | 10.6 | Not Started |
| 11.1 | Identifier extraction utility | 10.7 | Not Started |
| 11.2 | Exact-identifier recall calculator | 11.1 | Not Started |
| 11.3 | Dev-only evaluation harness script | 11.2 | Not Started |
| 12.1 | Local CA generation + trust store install | 10.7 | Not Started |
| 12.2 | Local HTTPS proxy + provider allowlist | 12.1 | Not Started |
| 12.3 | SSE `.tee()` + `PROVIDER_CAPTURE` node creation | 12.2 | Not Started |
| 12.4 | Wire `stenod enable-network-capture` | 12.3 | Not Started |
| 12.5 | Wire `stenod disable-network-capture` + uninstall test | 12.4 | Not Started |
| 13.1 | MCP resource exposure of handoff | 10.7 | Not Started |
| 14.1 | `SECURITY.md` | 12.5 | Not Started |
| 14.2 | Final README pass | 14.1 | Not Started |
| 14.3 | npm publish dry-run + package.json review | 14.2 | Not Started |

65 phases total. Deliberately granular enough that no phase requires more than one clear judgment call, and coarse enough that "one phase" still means "one real, testable unit of the system" — not an arbitrarily sliced line of code.

---

## Milestone 0 — Repo Foundation

#### Phase 0.1 — Project Init
- **Depends on:** —
- **SSOT ref:** §7, §11
- **Build:** Node.js + TypeScript project, strict mode enabled in `tsconfig.json`. Folder structure with clean module boundaries: `src/capture/`, `src/storage/`, `src/compiler/`, `src/cli/`, `src/delivery/`. `package.json` with name `stenod`, MIT license field.
- **Do NOT:** Add any runtime dependency not in the Locked Technology Decisions table yet — this phase is scaffolding only.
- **Done when:**
  - [ ] `npm install` succeeds with zero dependencies beyond TypeScript/dev tooling
  - [ ] `tsc --noEmit` passes on an empty project
  - [ ] Folder structure matches exactly
- **Verify:** inspect `package.json` and folder tree directly.

#### Phase 0.2 — README + LICENSE
- **Depends on:** 0.1
- **SSOT ref:** §11
- **Build:** `README.md` — brief, one paragraph on what Stenod is, link to `STENOD_SSOT.md` for full detail. `LICENSE` — MIT, standard text.
- **Do NOT:** Write `CONTRIBUTING.md` or any contribution-facing docs — explicitly out of scope per SSOT §11 for now.
- **Done when:**
  - [ ] README exists, under ~30 lines, links to SSOT
  - [ ] LICENSE is valid, standard MIT text with correct year/holder
- **Verify:** read both files directly.

#### Phase 0.3 — Test Framework Setup
- **Depends on:** 0.1
- **SSOT ref:** §7
- **Build:** `vitest` configured, `npm test` script wired, one trivial placeholder test proving the harness runs.
- **Done when:**
  - [ ] `npm test` runs and passes on the placeholder test
- **Verify:** run `npm test`.

#### Phase 0.4 — Lint/Format Setup
- **Depends on:** 0.1
- **SSOT ref:** (infra hygiene, not explicitly in SSOT — standard baseline to prevent technical debt per your own stated goal)
- **Build:** `eslint` + `@typescript-eslint`, `prettier`, basic config, `npm run lint` script.
- **Done when:**
  - [ ] `npm run lint` runs clean on the empty scaffold
- **Verify:** run `npm run lint`.

#### Phase 0.5 — CI Pipeline
- **Depends on:** 0.3, 0.4
- **SSOT ref:** (infra hygiene, not in SSOT — same category as 0.4, a
  standard baseline that supports the project's stated no-technical-debt goal)
- **Build:** a GitHub Actions workflow (`.github/workflows/ci.yml`) that
  runs on every push and pull request to `main`: `npm ci`, `npm run lint`,
  `npm test`. Nothing beyond that — no deploy step, no npm publish. CD
  (publishing) stays a manual, deliberate step per Phase 14.3, not automated.
- **Do NOT:** add a publish/deploy step. Do NOT add build matrix testing
  across multiple OSes yet — this project is already Unix/Mac-only for
  several capture-layer phases (per SSOT §9), so a single Ubuntu runner
  is the correct scope for now. Do NOT add coverage reporting, badges,
  or anything beyond lint+test — those are separate, later decisions.
- **Done when:**
  - A push to a branch triggers the workflow and shows pass/fail status
    on GitHub
  - A deliberately broken test or lint violation, pushed to a test
    branch, causes the workflow to fail visibly
- **Verify:** push a real commit and confirm the Actions tab shows a
  run; optionally push one deliberate failure to confirm red status
  actually appears, then revert it.

---

## Milestone 1 — Storage Layer

#### Phase 1.1 — SQLite Connection + WAL Pragmas
- **Depends on:** 0.1
- **SSOT ref:** §6.2
- **Build:** `better-sqlite3` connection module. On open: `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`, `PRAGMA cache_size=-64000`, `PRAGMA foreign_keys=ON`. The FK pragma is set here (not in individual schema files) because it is a per-connection runtime setting that every schema table with `REFERENCES` clauses depends on.
- **Do NOT:** Create any tables yet.
- **Done when:**
  - [ ] Connection opens against a fresh file
  - [ ] All three WAL pragmas confirmed active via query after open (`journal_mode=wal`, `synchronous=1`, `cache_size=-64000`)
  - [ ] `PRAGMA foreign_keys` confirmed ON after open
- **Verify:** test asserting `PRAGMA journal_mode` returns `wal`, etc.

#### Phase 1.2 — `graph_nodes` Table
- **Depends on:** 1.1
- **SSOT ref:** §6.2
- **Build:** exact schema — `id` (TEXT PK), `event_id` (INTEGER), `type` (ENUM: `FILE_STATE`, `TERMINAL_ERROR`, `TERMINAL_SUCCESS`, `PROVIDER_CAPTURE`, `CONSTRAINT`), `content` (TEXT), `fsm_state` (ENUM: `IDE_IDLE`, `RUNTIME_ERR`, `DOC_EDIT`, `DIFF_SUBMIT`, `PROVISIONAL_PANIC`), `constraint_key` (TEXT, nullable), `status` (ENUM: `ACTIVE`, `REJECTED`, `SUPERSEDED`), `source_file` (TEXT, nullable), `created_at` (INTEGER).
- **Do NOT:** Build `graph_edges` or `manifest_log` yet. Do not add columns beyond this list.
- **Done when:**
  - [ ] Table creates cleanly
  - [ ] All 9 columns present, correct types
  - [ ] Enum values enforced (CHECK constraint or app-layer — document which choice was made)
- **Verify:** `.schema graph_nodes` inspection + insert/select test.

#### Phase 1.3 — `graph_edges` Table
- **Depends on:** 1.1
- **SSOT ref:** §6.2
- **Build:** exact schema — `id` (TEXT PK), `from_node_id`/`to_node_id` (TEXT, FK to `graph_nodes.id`), `edge_type` (ENUM: `REPLACES`, `CAUSED_BY`, `CONTRADICTS`, `DEPENDS_ON`), `created_at` (INTEGER).
- **Done when:**
  - [ ] Table creates cleanly, FK constraints active
  - [ ] Insert fails on a `from_node_id`/`to_node_id` that doesn't exist in `graph_nodes`
- **Verify:** FK-violation test + valid insert/select test.

#### Phase 1.4 — `manifest_log` Table
- **Depends on:** 1.1
- **SSOT ref:** §6.2
- **Build:** exact schema — `id` (TEXT PK), `created_at` (INTEGER), `node_ids` (TEXT, JSON array), `token_count` (INTEGER), `outcome` (ENUM nullable: `WORKED`, `FAILED`).
- **Done when:**
  - [ ] Table creates cleanly
  - [ ] `outcome` accepts NULL and both enum values, rejects anything else
- **Verify:** insert/select round-trip test including NULL outcome case.

#### Phase 1.5 — Schema Versioning
- **Depends on:** 1.2, 1.3, 1.4
- **SSOT ref:** §6.2
- **Build:** `PRAGMA user_version` tracking + a migration runner that applies pending migrations in order on connect.
- **Done when:**
  - [ ] Fresh DB ends at the current expected version
  - [ ] Runner is idempotent — running it twice doesn't double-apply
- **Verify:** test simulating an older `user_version`, confirm migration runs exactly once and lands at current version.

#### Phase 1.6 — Storage Round-Trip Tests
- **Depends on:** 1.5
- **SSOT ref:** §6.2
- **Build:** Comprehensive unit test suite covering CRUD on all three tables plus FK/enum constraint enforcement, consolidating and extending the per-table tests from 1.2–1.4.
- **Done when:**
  - [ ] All three tables have full CRUD test coverage
  - [ ] `npm test` green
- **Verify:** run `npm test -- storage`.

---

## Milestone 2 — Workspace & Security Baseline

#### Phase 2.1 — Workspace Sandboxing
- **Depends on:** 1.6
- **SSOT ref:** §6.1
- **Build:** resolve project root to an absolute path, create `.stenod/` directory, PID lock file preventing a second daemon from attaching to the same root.
- **Done when:**
  - [ ] Second daemon attempt on the same root fails with a clear error
  - [ ] Stale lock file (from a crashed process) is detected and cleaned up correctly
- **Verify:** test spawning two attach attempts; test simulating a stale lock.

#### Phase 2.2 — Local Auth Token
- **Depends on:** 2.1
- **SSOT ref:** §6.1, §10
- **Build:** token generation at init, stored at `.stenod/token`, rotation logic for `init --reset`.
- **Done when:**
  - [ ] Token generated is cryptographically random, sufficient length
  - [ ] Rotation invalidates the old token
- **Verify:** test token uniqueness across multiple inits; test old token rejected post-rotation.

#### Phase 2.3 — IPC Scaffold + Token Enforcement
- **Depends on:** 2.2
- **SSOT ref:** §6.1, §7
- **Build:** Unix Domain Socket (Linux/Mac) / Named Pipe (Windows) scaffold. Every connection must present the valid token or be rejected.
- **Do NOT:** Wire any real capture logic through this yet — connection + auth only.
- **Done when:**
  - [ ] Connection with correct token succeeds
  - [ ] Connection with missing/wrong token is rejected
- **Verify:** test both cases against a running socket.

---

## Milestone 3 — FSM & Lifecycle Core

#### Phase 3.1 — FSM State Enum + Transitions
- **Depends on:** 1.6
- **SSOT ref:** §6.3
- **Build:** `IDE_IDLE → RUNTIME_ERR → DOC_EDIT → DIFF_SUBMIT`, with a direct `RUNTIME_ERR → DIFF_SUBMIT` skip tagged `PROVISIONAL_PANIC`. Pure state-transition logic, no I/O yet.
- **Done when:**
  - [ ] All valid transitions implemented
  - [ ] The panic-skip case is correctly detected and tagged
- **Verify:** table-driven test covering every transition path including the panic case.

#### Phase 3.2 — Recency Decay Function
- **Depends on:** 3.1
- **SSOT ref:** §6.3
- **Build:** `decay(Δt) = 1 / (1 + ln(1 + Δt_seconds))` — the corrected formula, not the original `1/ln(1+Δt)`.
- **Done when:**
  - [ ] `decay(0) === 1` exactly, no division-by-zero
  - [ ] Function is monotonically decreasing for Δt > 0
- **Verify:** unit test at Δt=0 explicitly, plus a monotonicity check across a range.

#### Phase 3.3 — LWW Conflict Resolution
- **Depends on:** 3.1
- **SSOT ref:** §6.3
- **Build:** a new `CONSTRAINT` node sharing a `constraint_key` with an existing `ACTIVE` constraint draws a `CONTRADICTS` edge to it and flips the old node's `status` to `SUPERSEDED`.
- **Done when:**
  - [ ] Second constraint with same key correctly supersedes the first
  - [ ] `CONTRADICTS` edge is correctly recorded
  - [ ] A third, unrelated constraint key is unaffected
- **Verify:** test the exact three-node scenario above.

#### Phase 3.4 — Time-Windowed Rejection
- **Depends on:** 3.1
- **SSOT ref:** §6.3
- **Build:** logic accepting a duration (e.g. `15m`), marking all `ACTIVE` nodes created within that window as `REJECTED`.
- **Do NOT:** implement any filesystem verification — this is a pure graph-metadata operation, per SSOT.
- **Done when:**
  - [ ] Nodes inside the window flip to `REJECTED`
  - [ ] Nodes outside the window are untouched
- **Verify:** test with nodes at controlled timestamps straddling the window boundary.

#### Phase 3.5 — Anti-Rot Timeout
- **Depends on:** 3.1
- **SSOT ref:** §6.3
- **Build:** if FSM remains in `RUNTIME_ERR` for τ > 600s, seal the active tree and apply decay.
- **Done when:**
  - [ ] Timeout correctly triggers at 600s, not before
  - [ ] "Sealing" behavior is clearly defined and tested (define precisely what changes on the node/tree when sealed)
- **Verify:** test with mocked/controlled time progression.

---

## Milestone 4 — Filesystem Capture Track

#### Phase 4.1 — chokidar Watcher + Ignore-List
- **Depends on:** 2.3, 3.1
- **SSOT ref:** §6.1
- **Build:** `chokidar` watcher over the project root. Excludes: `.env`, `.git/`, `node_modules/`, common build dirs (`dist/`, `build/`, `target/`, `.next/`), anything in the project's own `.gitignore`, binaries > 500KB.
- **Done when:**
  - [ ] All listed exclusions verified not to trigger events
  - [ ] `.gitignore` parsing correctly extends the exclusion set
  - [ ] A normal source file save does trigger an event
- **Verify:** test against a fixture directory containing one of each excluded/included case.

#### Phase 4.2 — web-tree-sitter Integration
- **Depends on:** 4.1
- **SSOT ref:** §6.2
- **Build:** `web-tree-sitter` + `tree-sitter-javascript`/`tree-sitter-typescript` grammars. On file save, parse AST in a background thread. Explicit `tree.delete()`/`parser.delete()` in `finally` blocks.
- **Done when:**
  - [ ] Parse completes correctly on valid JS/TS fixtures
  - [ ] No memory growth across repeated parse cycles (basic leak check)
- **Verify:** parse correctness test + a loop-N-times memory check.

#### Phase 4.3 — Constraint Comment Syntax Parser
- **Depends on:** 4.2
- **SSOT ref:** §6.2
- **Build:** recognize `// VCS: constraint[key]=value` wherever tree-sitter identifies a comment node.
- **Done when:**
  - [ ] Correctly extracts key/value from a valid constraint comment
  - [ ] Ignores ordinary comments that don't match the pattern
- **Verify:** fixture file with both constraint and non-constraint comments.

#### Phase 4.4 — `FILE_STATE` Node Creation
- **Depends on:** 4.2, 3.1
- **SSOT ref:** §6.2, §6.3
- **Build:** wire filesystem events into `graph_nodes` writes (`FILE_STATE` type), including FSM state association (`DOC_EDIT` on save).
- **Done when:**
  - [ ] A file save produces exactly one correctly-typed node with correct `fsm_state`
- **Verify:** end-to-end test: save a fixture file, confirm the resulting DB row.

#### Phase 4.5 — Secret Redaction (Filesystem)
- **Depends on:** 4.4
- **SSOT ref:** §6.1, §10
- **Build:** regex pass for common secret shapes (cloud key patterns, bearer tokens, generic `key=`/`secret=` assignments) applied to file content before it reaches `graph_nodes.content`.
- **Done when:**
  - [ ] Known secret-shaped test strings are redacted, not stored raw
  - [ ] Ordinary code content passes through unmodified
- **Verify:** test with a fixture file containing both a fake secret and normal code.

---

## Milestone 5 — Terminal Capture Track

#### Phase 5.1 — node-pty Shell Wrapper
- **Depends on:** 2.3, 3.1
- **SSOT ref:** §6.1
- **Build:** `node-pty` wraps the developer's shell, Unix/Mac only per SSOT (Windows explicitly out of scope for now).
- **Done when:**
  - [ ] A wrapped shell correctly relays stdin/stdout to the real terminal unmodified
- **Verify:** manual/integration test running a simple command through the wrapper.

#### Phase 5.2 — Batching + Backpressure
- **Depends on:** 5.1
- **SSOT ref:** §6.1
- **Build:** 16ms batching, 64KB high-water mark, overflow spills to temp file, stream pauses/resumes.
- **Done when:**
  - [ ] Output under 64KB batches correctly at ~16ms
  - [ ] Output exceeding 64KB triggers the temp-file overflow path without data loss
- **Verify:** test with a command producing a large burst of output, confirm nothing is dropped.

#### Phase 5.3 — Exit-Code Signal
- **Depends on:** 5.2, 3.1
- **SSOT ref:** §6.1, §6.3
- **Build:** command exit code drives `TERMINAL_SUCCESS`/`TERMINAL_ERROR` node creation and the corresponding FSM transition.
- **Done when:**
  - [ ] Exit 0 produces `TERMINAL_SUCCESS`
  - [ ] Non-zero exit produces `TERMINAL_ERROR` and triggers `RUNTIME_ERR`
- **Verify:** test running a passing and a failing fixture command.

#### Phase 5.4 — Long-Running Process Heuristic
- **Depends on:** 5.3
- **SSOT ref:** §6.1
- **Build:** for processes that don't exit within the session, watch stderr for crash-shaped patterns (`Error:`, `Traceback`, `panic:`, unhandled rejection) as a secondary, explicitly-labeled heuristic signal.
- **Done when:**
  - [ ] A long-running fixture process emitting a crash-shaped stderr line produces a node tagged as heuristic-detected (distinguishable from the exit-code path)
- **Verify:** test with a fixture that never exits but emits a stack-trace-shaped line.

#### Phase 5.5 — Secret Redaction (Terminal)
- **Depends on:** 5.3
- **SSOT ref:** §6.1, §10
- **Build:** apply the same redaction pass from Phase 4.5 to terminal content before storage.
- **Done when:**
  - [ ] Same redaction guarantees as 4.5, applied to terminal output
- **Verify:** reuse the 4.5 test approach against terminal fixture output.

---

## Milestone 6 — Ingestion Queue ("The Bouncer")

#### Phase 6.1 — Serialized Queue
- **Depends on:** 4.4, 5.3
- **SSOT ref:** §6.1
- **Build:** single serialized queue merging filesystem and terminal event streams into one write path to SQLite.
- **Done when:**
  - [ ] Simultaneous fs + terminal events are written without interleaving corruption
  - [ ] Write latency under 5ms per event under normal load
- **Verify:** concurrent-event test measuring latency.

#### Phase 6.2 — Backpressure / Overflow Handling
- **Depends on:** 6.1
- **SSOT ref:** §6.1
- **Build:** shared max in-flight depth; overflow spills to an append-only disk buffer, drained FIFO, never silently dropped.
- **Done when:**
  - [ ] Forced overflow condition results in zero dropped events, correct FIFO order on drain
- **Verify:** test flooding the queue past its in-memory limit, confirm full recovery.

#### Phase 6.3 — Burst-Load Integration Test
- **Depends on:** 6.2
- **SSOT ref:** §6.1
- **Build:** full integration test simulating a realistic burst (e.g. a git rebase generating many file events plus terminal spam simultaneously).
- **Done when:**
  - [ ] Zero `SQLITE_BUSY` errors under the simulated burst
  - [ ] All events accounted for in the DB afterward
- **Verify:** run the burst test, inspect final row counts against expected.

---

## Milestone 7 — Daemon Lifecycle

#### Phase 7.1 — `stenod init`
- **Depends on:** 2.2
- **SSOT ref:** §5, §6.1
- **Build:** command that runs workspace sandboxing (2.1), token generation (2.2), and generates a systemd user unit (Linux) or launchd plist (Mac) with `Restart=on-failure`.
- **Do NOT:** wire this into the full CLI yet (that's Milestone 10) — build and test the underlying function directly.
- **Done when:**
  - [ ] Running init on a fresh directory produces `.stenod/`, token file, and a valid service unit file
- **Verify:** inspect generated files; validate service unit syntax.

#### Phase 7.2 — `stenod start` / `stenod stop`
- **Depends on:** 6.3, 7.1
- **SSOT ref:** §5
- **Build:** daemon process start/stop logic, wiring together the capture tracks (4.x, 5.x) and the ingestion queue (6.x) into one running process.
- **Done when:**
  - [ ] `start` brings up a daemon that actually captures fs+terminal events
  - [ ] `stop` cleanly shuts it down, no orphaned processes
- **Verify:** integration test: start, trigger a file save, confirm a DB row, stop, confirm process exit.

#### Phase 7.3 — `stenod status`
- **Depends on:** 7.2
- **SSOT ref:** §5
- **Build:** reports daemon health, node count, last event timestamp.
- **Done when:**
  - [ ] Status output matches actual DB state
- **Verify:** compare status output against a direct DB query.

#### Phase 7.4 — Crash Recovery Validation
- **Depends on:** 7.2
- **SSOT ref:** §6.1
- **Build:** no new code — this phase is validation only, confirming the systemd/launchd unit from 7.1 actually restarts the daemon on crash.
- **Done when:**
  - [ ] Force-killing the daemon process results in automatic restart within a reasonable window
- **Verify:** manual test: `kill -9` the daemon, confirm it comes back.

---

## Milestone 8 — Compiler Engine

#### Phase 8.1 — Token Counting
- **Depends on:** 1.6
- **SSOT ref:** §6.4
- **Build:** `gpt-tokenizer` integration measuring `token_cost` per node.
- **Done when:**
  - [ ] Token counts for known fixture strings match expected values
- **Verify:** unit test against known-length fixtures.

#### Phase 8.2 — Utility Score Calculation
- **Depends on:** 3.2
- **SSOT ref:** §6.4
- **Build:** `v_i = λ1·decay(Δt) + λ2·causal_centrality + λ3·constraint_priority`, static constants `λ1=0.4, λ2=0.4, λ3=0.2`.
- **Do NOT:** make λ values configurable or adaptive — static per SSOT.
- **Done when:**
  - [ ] Score calculation matches hand-computed expected values on fixture nodes
- **Verify:** unit test with hand-calculated expected scores.

#### Phase 8.3 — Causal Centrality
- **Depends on:** 1.6
- **SSOT ref:** §6.4
- **Build:** simple in/out-degree count within a node's own edge set.
- **Done when:**
  - [ ] Degree counts match expected values on a small fixture graph
- **Verify:** unit test against a hand-built fixture graph.

#### Phase 8.4 — Greedy-by-Ratio Packing
- **Depends on:** 8.1, 8.2, 8.3
- **SSOT ref:** §6.4
- **Build:** traverse graph, drop non-`ACTIVE` nodes, force-include all `CONSTRAINT` nodes, sort remaining by `v_i / token_cost` descending, pack until token budget hit.
- **Done when:**
  - [ ] Constraint nodes always included regardless of score
  - [ ] Non-active nodes never appear in output
  - [ ] Packing respects the token budget exactly (never exceeds it)
- **Verify:** unit test with a fixture graph including active/rejected/superseded/constraint nodes, confirm correct selection.

#### Phase 8.5 — Local Improvement Pass
- **Depends on:** 8.4
- **SSOT ref:** §6.4
- **Build:** for the lowest-value included node, check whether swapping for the highest-value excluded node that still fits improves total value; repeat until no improving swap exists.
- **Done when:**
  - [ ] A constructed fixture where greedy-alone is suboptimal is correctly improved by this pass
  - [ ] Pass terminates (no infinite loop) on all test fixtures
- **Verify:** unit test with a deliberately constructed suboptimal-greedy scenario.

#### Phase 8.6 — U-Shaped Output Structuring
- **Depends on:** 8.5
- **SSOT ref:** §6.4
- **Build:** structure final output as constraints (primacy) → packed causal graph (middle) → resume instruction (recency).
- **Done when:**
  - [ ] Output ordering matches the three-zone structure exactly on a fixture
- **Verify:** unit test asserting zone ordering.

#### Phase 8.7 — "Next Actions" Block
- **Depends on:** 8.6, 3.1
- **SSOT ref:** §6.4
- **Build:** surface the FSM's current unresolved state (e.g. last unresolved `RUNTIME_ERR`) as an explicit block in the recency zone.
- **Done when:**
  - [ ] A fixture with an unresolved error correctly produces a Next Actions block referencing it
  - [ ] A fixture with no unresolved state produces no such block (or a correctly empty one — decide and document which)
- **Verify:** unit test for both cases.

#### Phase 8.8 — Compiler Correctness/Determinism Tests
- **Depends on:** 8.7
- **SSOT ref:** §6.4
- **Build:** comprehensive test suite proving the same graph state always produces the same manifest output, byte for byte.
- **Done when:**
  - [ ] Running the compiler twice on identical input produces identical output
- **Verify:** run `npm test -- compiler` twice, diff outputs.

---

## Milestone 9 — Delivery & Audit

#### Phase 9.1 — Clipboard Delivery
- **Depends on:** 8.8
- **SSOT ref:** §6.5
- **Build:** `clipboardy` integration copying the compiled manifest.
- **Done when:**
  - [ ] Compiled manifest correctly lands on the system clipboard
- **Verify:** integration test reading clipboard content after a handoff call.

#### Phase 9.2 — `manifest_log` Write
- **Depends on:** 9.1
- **SSOT ref:** §6.5
- **Build:** every compiled manifest writes a row (node IDs, token count, null outcome) before delivery.
- **Done when:**
  - [ ] Each handoff produces exactly one correct `manifest_log` row
- **Verify:** test triggering a handoff, inspecting the resulting row.

#### Phase 9.3 — Feedback Tagging
- **Depends on:** 9.2
- **SSOT ref:** §6.5, §4
- **Build:** `--worked`/`--failed` updates the `outcome` column on the most recent `manifest_log` row.
- **Done when:**
  - [ ] Correct row updated, others untouched
- **Verify:** test with multiple log rows, confirm only the most recent is affected.

---

## Milestone 10 — CLI Assembly

#### Phase 10.1 — CLI Framework Setup
- **Depends on:** 0.1
- **SSOT ref:** §5
- **Build:** `commander` skeleton registering all command names from SSOT §5 as stubs (no logic wired yet).
- **Done when:**
  - [ ] `stenod --help` lists all commands with correct names
- **Verify:** run `stenod --help`, compare against SSOT §5 command list exactly.

#### Phase 10.2 — Wire `stenod init`
- **Depends on:** 10.1, 7.1
- **Build:** connect the CLI stub to the Phase 7.1 implementation.
- **Done when:**
  - [ ] `stenod init` run from the CLI produces identical results to calling 7.1 directly
- **Verify:** CLI invocation test.

#### Phase 10.3 — Wire `stenod start`/`stop`/`status`
- **Depends on:** 10.2, 7.3
- **Done when:** [ ] each command correctly invokes its underlying implementation
- **Verify:** CLI invocation tests for all three.

#### Phase 10.4 — Wire `stenod handoff` (+worked/failed)
- **Depends on:** 10.3, 9.3
- **Done when:** [ ] `stenod handoff`, `stenod handoff --worked`, `stenod handoff --failed` all behave correctly end to end
- **Verify:** CLI invocation tests for all three variants.

#### Phase 10.5 — Wire `stenod reject --since`
- **Depends on:** 10.4, 3.4
- **Done when:** [ ] duration parsing + rejection logic correctly triggered from CLI
- **Verify:** CLI invocation test with a controlled fixture graph.

#### Phase 10.6 — Wire `stenod anchor`
- **Depends on:** 10.4
- **Done when:** [ ] `stenod anchor "<text>"` correctly creates a `CONSTRAINT` node
- **Verify:** CLI invocation test, inspect resulting node.

#### Phase 10.7 — Full End-to-End Integration Test
- **Depends on:** 10.6
- **SSOT ref:** whole document
- **Build:** one comprehensive test: init a fixture project, start the daemon, simulate file saves + terminal errors + a rejection + an anchor, run handoff, assert the manifest contains exactly what it should given the simulated session.
- **Done when:**
  - [ ] This single test passes, proving the entire default-tier pipeline works together correctly
- **Verify:** run the test, manually review the resulting manifest content against what the simulated session should produce.

---

## Milestone 11 — Evaluation Harness

#### Phase 11.1 — Identifier Extraction Utility
- **Depends on:** 10.7
- **SSOT ref:** §12
- **Build:** utility extracting function names, variable names, and error codes from `graph_nodes` content (reuse AST info from 4.2 where available).
- **Done when:**
  - [ ] Correct identifier extraction on fixture source content
- **Verify:** unit test against known fixture identifiers.

#### Phase 11.2 — Exact-Identifier Recall Calculator
- **Depends on:** 11.1
- **SSOT ref:** §12
- **Build:** compares identifiers present in source graph nodes against identifiers present in a compiled manifest, computes recall fraction.
- **Done when:**
  - [ ] Correct recall percentage on a hand-computed fixture case
- **Verify:** unit test with known expected recall value.

#### Phase 11.3 — Dev-Only Evaluation Harness Script
- **Depends on:** 11.2
- **SSOT ref:** §12
- **Build:** an internal npm script (not a public CLI command — not in SSOT §5's interface list) that runs the recall calculator against a real project's graph for development-time use.
- **Do NOT:** expose this as a `stenod` CLI command — SSOT does not list one.
- **Done when:**
  - [ ] Script runs against a real populated `.stenod/graph.db` and outputs a recall number
- **Verify:** run the script manually against test data.

---

## Milestone 12 — Opt-in Network Capture Tier

#### Phase 12.1 — Local CA Generation + Trust Store Install
- **Depends on:** 10.7
- **SSOT ref:** §6.1
- **Build:** `node-forge` (or `mockttp`'s built-in CA generation) to create a local root CA; install into the OS trust store, only when explicitly triggered.
- **Do NOT:** trigger this automatically from `init` or `start` — opt-in only, per SSOT.
- **Done when:**
  - [ ] CA generation produces a valid certificate
  - [ ] Trust store installation confirmed via OS-level check
- **Verify:** test cert validity; manual OS trust store inspection.

#### Phase 12.2 — Local HTTPS Proxy + Provider Allowlist
- **Depends on:** 12.1
- **SSOT ref:** §6.1
- **Build:** `mockttp`-based local proxy, allowlisting only known AI provider domains (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`); all other traffic passes through untouched and unlogged.
- **Done when:**
  - [ ] Requests to allowlisted domains are visible to the daemon
  - [ ] Requests to any other domain are confirmed NOT logged/captured
- **Verify:** test with both an allowlisted and a non-allowlisted mock request.

#### Phase 12.3 — SSE `.tee()` + `PROVIDER_CAPTURE` Node Creation
- **Depends on:** 12.2
- **SSOT ref:** §6.1, §6.2
- **Build:** intercepted SSE streams are `.tee()`'d — one stream passes through unmodified to the caller, the other feeds `PROVIDER_CAPTURE` node creation.
- **Do NOT:** let this drive FSM transitions — per SSOT §6.3, `PROVIDER_CAPTURE` nodes are content-only.
- **Done when:**
  - [ ] Caller-facing stream is byte-identical to the unintercepted case
  - [ ] Daemon-facing stream correctly produces `PROVIDER_CAPTURE` nodes
  - [ ] No FSM state change results from this
- **Verify:** test comparing intercepted vs. non-intercepted stream output; confirm FSM state unchanged.

#### Phase 12.4 — Wire `stenod enable-network-capture`
- **Depends on:** 12.3
- **Done when:** [ ] command correctly triggers 12.1–12.3 in sequence, with clear explanation shown to the user before acting
- **Verify:** CLI invocation test.

#### Phase 12.5 — Wire `stenod disable-network-capture` + Uninstall Test
- **Depends on:** 12.4
- **SSOT ref:** §6.1, §10
- **Build:** fully reverts CA trust store installation and proxy settings.
- **Done when:**
  - [ ] After disable, the CA is confirmed removed from the trust store
  - [ ] Proxy settings confirmed reverted
  - [ ] A fresh enable → disable → enable cycle works cleanly (no leftover state)
- **Verify:** full enable/disable/enable integration test with OS-level trust store checks.

---

## Milestone 13 — Optional MCP Interface

#### Phase 13.1 — MCP Resource Exposure
- **Depends on:** 10.7
- **SSOT ref:** §5, §6.5
- **Build:** expose `stenod handoff` as an MCP resource/tool. Must degrade gracefully to clipboard-only if MCP transport is unavailable.
- **Do NOT:** make this a replacement for clipboard delivery — it's additive convenience only, per SSOT.
- **Done when:**
  - [ ] MCP-connected client can retrieve the manifest directly
  - [ ] Clipboard delivery still works identically when MCP isn't in use
- **Verify:** test both paths independently.

---

## Milestone 14 — Documentation & Release Prep

#### Phase 14.1 — `SECURITY.md`
- **Depends on:** 12.5
- **SSOT ref:** §10
- **Build:** plain-language doc stating exactly what's captured, where it's stored (always local), and precisely what the opt-in tier does and doesn't do.
- **Done when:**
  - [ ] Doc accurately reflects the actual implemented behavior, not aspirational behavior
- **Verify:** manual review against the actual built system.

#### Phase 14.2 — Final README Pass
- **Depends on:** 14.1
- **Build:** install instructions, usage examples, link to SECURITY.md and SSOT.
- **Done when:**
  - [ ] A fresh reader could install and run `stenod init && stenod start` successfully from the README alone
- **Verify:** manual walkthrough following only the README.

#### Phase 14.3 — npm Publish Dry-Run
- **Depends on:** 14.2
- **Build:** `npm publish --dry-run`, final `package.json` review (name `stenod`, correct `bin` entry, correct `files`/`main` fields).
- **Done when:**
  - [ ] Dry-run completes with no errors, package contents look correct
- **Verify:** inspect dry-run output directly.