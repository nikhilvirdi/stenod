# Stenod

A local, deterministic, out-of-band daemon that captures the causal history
of a coding session (file changes, terminal outcomes, optional AI-provider
network traffic) and compiles it into a Handoff Manifest for resuming work
in any AI tool. Full rationale: `STENOD_SSOT.md`. Full execution roadmap
and phase-by-phase spec: `WORKPLAN.md`.

**Before doing anything, read WORKPLAN.md's Master Status Tracker.** Find
the next phase to build: status `Not Started`, every entry in its
`Depends on` column already `Verified`. Then read that phase's full entry
in WORKPLAN.md (Build / Do NOT / Done when / Verify) and the SSOT section
it references, before writing a single line of code.

## The one rule that overrides convenience every time

**One phase per implementation pass. Never more — even if two phases look
related, small, or trivial to combine.** This is the project's core
anti-drift mechanism. If asked to "just also do phase X while you're in
there," refuse and explain why. A gap in spec (missing table, undefined
flag, ambiguous behavior) is a reason to stop and ask — never invented or
improvised.

## Commands

- Install: `npm install`
- Test: `npm test` (vitest) — a phase without passing tests is not done,
  regardless of what the code looks like
- Test a subset: `npm test -- <pattern>`
- Lint: `npm run lint` (eslint + prettier)
- Type-check: `npx tsc --noEmit`

## Architecture (module boundaries — don't cross them casually)

- `src/capture/` — filesystem (chokidar) + terminal (node-pty) capture tracks
- `src/storage/` — SQLite (better-sqlite3, WAL mode): `graph_nodes`,
  `graph_edges`, `manifest_log`
- `src/compiler/` — utility scoring, greedy-by-ratio + local improvement
  pass, U-shaped manifest assembly
- `src/cli/` — commander-based CLI surface
- `src/delivery/` — clipboard delivery + `manifest_log` writes

## Locked dependencies

`better-sqlite3`, `commander`, `chokidar`, `node-pty`, `gpt-tokenizer`,
`vitest`, `clipboardy`, `mockttp`, `node-forge`, `web-tree-sitter` +
`tree-sitter-javascript`/`tree-sitter-typescript`, `eslint` +
`@typescript-eslint`, `prettier`. Full table with pinned versions in
WORKPLAN.md. Do not substitute or add a dependency not on that list —
if a phase seems to need one, stop and ask instead.

## Non-negotiable constraints

- **Determinism:** same input state → same output, always. No randomness,
  no wall-clock branching beyond the already-specified decay/timeout
  logic, no unlisted external calls.
- **Zero network calls** except the explicitly opt-in AI-provider capture
  tier (Milestone 12). Never trigger CA install or proxy setup from
  `init` or `start`.
- **λ weights are static** (0.4 / 0.4 / 0.2) — never configurable, never
  learned.
- If a phase touches any file outside its own listed scope — especially
  one belonging to an already-`Verified` phase — flag that, don't
  silently fix it forward. Treat it as a regression signal.

## Git discipline

One commit per phase that reaches `Verified` (not per `Built`), message
referencing the phase number and name — e.g.
`git commit -m "Phase 3.2: recency decay function"`.

## Verification — read this before starting any phase

This project was designed around two different agents: one implements,
a separate one verifies against the checklist with fresh eyes. That
separation is the point — an agent grading its own work misses the same
blind spots twice, and a phase should never self-certify as `Verified`.

Since Claude Code can now do both roles, **keep the roles split anyway**:
implement the phase here, then take the diff/output to a *separate*
context — a fresh Claude.ai conversation, or a new Claude Code session
after `/clear` — and have it check the phase's "Done when" checklist and
SSOT section, PASS/FAIL per item. Only update WORKPLAN.md's status to
`Verified` after an explicit, separate PASS. Never mark a phase you just
built as `Verified` yourself in the same pass — mark it `Built
(unverified)` and stop there.
