---
description: Implement exactly one phase from WORKPLAN.md — no more, no less
argument-hint: [phase number, e.g. 4.1 — omit to auto-pick the next unblocked phase]
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(npm test*), Bash(npm run lint*), Bash(npx tsc --noEmit*), Bash(git status), Bash(git diff*), Bash(git log*)
---

Implement ONLY phase $ARGUMENTS from WORKPLAN.md. Per AGENTS.md, you are
this project's primary implementer for complex phases — capture
internals, the interpretation cascade, storage schema, compiler logic.
Simple, well-scoped phases (docs, straightforward config) may instead be
implemented directly by Antigravity; if this phase looks like one of
those, say so before proceeding.

If no phase number was given: read the Master Status Tracker in
WORKPLAN.md and pick the first `Not Started` phase whose every
`Depends on` entry is already `Verified`. If more than one phase
qualifies, tell me which candidates you found and ask me to pick
before proceeding.

Before writing any code:
1. Read ARCHITECTURE.md's referenced section(s) for this phase.
2. Read this phase's full entry in WORKPLAN.md — Build, Do NOT, Done
   when, Verify.
3. Re-read AGENTS.md's "Non-negotiable constraints" and "Locked
   dependencies" sections.

Build exactly what "Build:" describes, using exactly the libraries in
WORKPLAN.md's Locked Technology Decisions table — no substitutions, no
extra dependencies. Respect every "Do NOT" line exactly as written.

If anything is ambiguous, missing from the spec, or inconsistent
between ARCHITECTURE.md and WORKPLAN.md: stop and ask me. Do not guess
or improvise a fix.

Every phase producing logic ships with passing tests in this same
pass. Run `npm test`, `npm run lint`, and `npx tsc --noEmit` before
considering the phase done.

When finished:
- Report each "Done when" checklist item and exactly how you verified
  it.
- Update this phase's row in WORKPLAN.md's Master Status Tracker to
  `Built (unverified)` — never mark it `Verified` yourself. That
  requires a separate verification pass, from a genuinely different
  context — Antigravity, by default, per AGENTS.md (see AGENTS.md and
  `/verify-phase`).
- Confirm you did not touch any file outside this phase's own scope,
  especially files belonging to an already-`Verified` phase.