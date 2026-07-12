# Stenod

A local, deterministic, out-of-band daemon that captures the causal history
of a coding session (file changes, terminal outcomes, optional AI-provider
network traffic) and compiles it into a Handoff Manifest for resuming work
in any AI tool. Full rationale: `ARCHITECTURE.md`.

**Before doing anything, check the project's internal status tracker for
the next phase to build:** status `Not Started`, every entry in its
`Depends on` column already `Verified`. Then read that phase's full build
spec (Build / Do NOT / Done when / Verify) and the architecture section it
references, before writing a single line of code.

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
- `src/daemon/` — daemon lifecycle (start/stop), terminal-bridge IPC handler
- `src/network/` — opt-in AI-provider capture tier: CA generation, trust
  store install/uninstall, HTTPS interception proxy, provider capture
- `src/workspace/` — sandboxing, auth token, local IPC scaffold
- `src/lifecycle/` — FSM, decay, LWW conflict resolution, rejection, anti-rot
- `src/mcp/` — MCP resource exposure of the handoff manifest
- `src/evaluation/` — exact-identifier recall calculator (dev-only harness)

## Locked dependencies

`better-sqlite3`, `commander`, `chokidar`, `node-pty`, `gpt-tokenizer`,
`vitest`, `clipboardy`, `mockttp`, `node-forge`, `@modelcontextprotocol/sdk`,
`web-tree-sitter` + `tree-sitter-javascript`/`tree-sitter-typescript`,
`eslint` + `@typescript-eslint`, `prettier`. Do not substitute or add a
dependency not on this list — if a phase seems to need one, stop and ask
instead.

## Non-negotiable constraints

- **Determinism:** same input state → same output, always. No randomness,
  no wall-clock branching beyond the already-specified decay/timeout
  logic, no unlisted external calls.
- **Zero network calls** except the explicitly opt-in AI-provider capture
  tier. Never trigger CA install or proxy setup from `init` or `start`.
- **λ weights are static** (0.4 / 0.4 / 0.2) — never configurable, never
  learned.
- **Terminal capture requires an explicit bridge.** The daemon runs
  detached with no TTY of its own — it can't spawn or attach to a shell.
  Terminal capture only happens via `stenod attach`, run separately in
  each interactive session.
- If a phase touches any file outside its own listed scope — especially
  one belonging to an already-`Verified` phase — flag that, don't
  silently fix it forward. Treat it as a regression signal.

## Git discipline

One commit per phase that reaches `Verified` (not per `Built`), message
referencing the phase number and name — e.g.
`git commit -m "Phase 3.2: recency decay function"`.

## Verification — read this before starting any phase

This project is designed around two separate roles: one agent implements,
a different agent (or a fresh context of the same agent) verifies against
the checklist with fresh eyes. That separation is the point — an agent
grading its own work misses the same blind spots twice, and a phase should
never self-certify as `Verified`.

Even if the same tool can technically do both roles, **keep the roles
split anyway**: implement the phase, then take the diff/output to a
genuinely separate context — a new conversation, a different agent, or a
fresh session after clearing history — and have it check the phase's
"Done when" checklist and the relevant architecture section, PASS/FAIL per
item. Only mark a phase `Verified` after an explicit, separate PASS. Never
mark a phase you just built as `Verified` yourself in the same pass — mark
it `Built (unverified)` and stop there.
