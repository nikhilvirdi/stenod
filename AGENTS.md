# Stenod

A local, deterministic, out-of-band daemon that captures the causal history
of a coding session — file changes, terminal outcomes, optionally an AI
tool's own reasoning, and optionally AI-provider network traffic — and
compiles it into a Handoff Manifest for resuming work in any AI tool. Full
rationale: `ARCHITECTURE.md`.

This is the single source of truth for how work gets done on this project.
`CLAUDE.md` and `ANTIGRAVITY.md` are both short pointers to this file, each with
one added line about which role that tool plays here — see
[Agent roles and file layout](#agent-roles-and-file-layout) at the bottom.
Edit rules in exactly one place: this one.

**Before doing anything, check `WORKPLAN.md` for the next phase to build:**
status `Not Started`, every entry in its `Depends on` column already
`Verified`. Then read that phase's full build spec (Build / Do NOT / Done
when / Verify) and the architecture section it references, before writing a
single line of code.

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

**Shipped (Stenod 1.0):**

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
- `src/evaluation/` — exact-identifier recall calculator (dev-only harness);
  once multi-tool capture ships, this needs to run against that too, not
  only the original filesystem/terminal source

**New, per the 2.0 design (build as their own phases, don't fold into the
above):**

- `src/capture/hooks/` — Tier-A receivers for tools with a structured hook
  system (Claude Code, Codex, Kiro), plus the router script that resolves
  each event's working directory up to a `.stenod/` directory before
  delivering anything
- `src/capture/artifacts/` — Tier-B plaintext session readers (Google
  Antigravity's brain folder), including the auxiliary out-of-project watch
  path and the project-matching logic
- `src/capture/adapters/` — Tier-C wrappers around borrowed, third-party
  parsers for undocumented formats (Cursor's chat storage). The rest of the
  codebase talks to the adapter's own interface, never to the borrowed
  parser's types directly
- `src/interpretation/` — the three-layer cascade that turns raw reasoning
  into scoreboard entries: Layer 1 (deterministic, `wink-nlp`-based) and
  Layer 2 (the optional AI tie-breaker client) live here. Layer 0 is not a
  new module — it's the existing `src/lifecycle/` FSM and LWW machinery,
  reused as-is against the new `DECISION` node type
- `src/integrations/` — `stenod integrate <tool>` / `stenod detach <tool>`:
  writes and removes hook configuration additively, confirms removal by
  re-reading the file, mirrors the existing `enable-network-capture` /
  `disable-network-capture` pattern in `src/network/`

**Deferred, not yet a module:** the companion dashboard and docs site. Per
lock, frontend work is sequenced after the capture and interpretation
engine is built and verified — see `ARCHITECTURE.md` §12.

## Locked dependencies

`better-sqlite3`, `commander`, `chokidar`, `node-pty`, `gpt-tokenizer`,
`vitest`, `clipboardy`, `mockttp`, `node-forge`, `@modelcontextprotocol/sdk`,
`web-tree-sitter` + `tree-sitter-javascript`/`tree-sitter-typescript`,
`eslint` + `@typescript-eslint`, `prettier`, **`wink-nlp` + its pinned
language model package** (approved for the Layer 1 deterministic text
interpreter — pin both to a Node version confirmed in CI, since the model
package version-locks to specific Node versions). One dependency is
approved-in-principle but not yet locked: a Tier-C format parser for
Cursor's undocumented chat storage, pending a license/maintenance/footprint
check before it's added to this list. Do not substitute or add any other
dependency without stopping and asking first — if a phase seems to need
one, that's a stop, not a judgment call.

## Non-negotiable constraints

**From 1.0, unchanged:**

- **Determinism:** same input state → same output, always. No randomness,
  no wall-clock branching beyond the already-specified decay/timeout
  logic, no unlisted external calls.
- **Zero network calls** except the explicitly opt-in AI-provider capture
  tier and the explicitly opt-in AI tie-breaker (see below). Never trigger
  CA install, proxy setup, or an AI call from `init` or `start`.
- **λ weights are static** (0.4 / 0.4 / 0.2) — never configurable, never
  learned.
- **Terminal capture requires an explicit bridge.** The daemon runs
  detached with no TTY of its own — it can't spawn or attach to a shell.
  Terminal capture only happens via `stenod attach`, run separately in
  each interactive session.
- If a phase touches any file outside its own listed scope — especially
  one belonging to an already-`Verified` phase — flag that, don't
  silently fix it forward. Treat it as a regression signal.

**New, per the 2.0 design:**

- **A hook script must never block the tool it's watching.** Every script
  Stenod installs is fire-and-forget: hand the event to the daemon and
  exit immediately, whether or not the daemon is reachable. If it isn't,
  spool locally; the script still exits without waiting. An out-of-band
  recorder that can stall the thing it's recording has stopped being
  out-of-band — treat this as a hard rule, not a best effort.
- **Tool integration is opt-in and reversible only through `stenod
  integrate` / `stenod detach`.** Never wire a hook or register a watch
  path from any other command. Additive only — never touch a tool's
  existing configuration entries.
- **Never write to a tool's own rule or instruction files** (`CLAUDE.md`,
  `.cursor/rules`, and similar). Read-and-flag only. Writing to them risks
  turning Stenod into a source of the exact staleness it exists to catch.
- **The AI tie-breaker (interpretation Layer 2) is fully optional and
  user-funded.** Runs on the user's own key, only, and only at the moment
  a handoff is explicitly requested — never automatically, never in the
  background, never on a schedule. Without a key configured, the tool must
  work in full; unresolved cases land as `OPEN`, not silently guessed.
- **No Python, no second language runtime.** This was decided once already
  for a reason still in force: it would reintroduce the cross-language IPC
  bridge the Node-only choice was specifically meant to eliminate. If NLP
  quality is ever the argument for revisiting this, that's a major,
  deliberate architectural conversation — not a dependency swap.
- **The companion dashboard is localhost-only, permanently.** No login, no
  hosted relay, no server that sees project data even transiently. If a
  future contributor proposes routing dashboard data through a server —
  even with a stated no-persistence policy — that is the exact tripwire
  this rule exists to catch. Refuse and point here.
- **Never silently merge or silently duplicate an ambiguous topic match.**
  When Layer 1 can't confidently tell whether two decisions are about the
  same thing, keep both active and raise a flagged `POSSIBLE_CONFLICT`
  rather than guessing either way.

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

**Phase 0, before any capture phase is built:** a bounded capture-surface
spike — wire minimal hooks into a real Claude Code session (and read a real
Antigravity brain folder) on a throwaway project, and confirm in writing
what the actual payloads contain, especially how much of the assistant's
own reasoning text rides along and whether `PreCompact` delivers content or
only a signal. Every Tier-A/Tier-B capture phase after this one should cite
that output, not assumptions from the design phase. If real payloads carry
less than assumed, the interpretation cascade already degrades safely
(more falls to Layer 1, or to `OPEN`) — recalibrate expectations, don't
redesign.

## Agent roles and file layout

- **`AGENTS.md`** (this file) — the only place real rules live. Edited here,
  nowhere else.
- **`CLAUDE.md`** — a pointer to this file, plus one line: Claude Code is
  the primary implementer. Complex phases — capture internals, the
  interpretation cascade, storage schema, compiler logic — route here.
- **`ANTIGRAVITY.md`** — a pointer to this file, plus one line: Antigravity
  (Gemini) handles verification, documentation, and simple, well-scoped
  coding tasks. It does not implement complex phases.
- This split isn't just a convenience — it's the implementer/verifier
  separation above, enforced by using genuinely different tools rather
  than relying on a fresh context of the same one.
- Codex is not currently in this rotation and isn't referenced in either
  pointer file. Standard naming (`AGENTS.md`) means adding it back later,
  if that changes, doesn't require restructuring anything here.