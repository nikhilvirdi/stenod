# Antigravity

All real rules for this project live in [`AGENTS.md`](./AGENTS.md). Read it
in full before touching anything — this file is a pointer, not a copy, so
nothing here goes stale independently of it.

**Your role on this project: verification, documentation, and simple,
well-scoped coding tasks.** Do not implement complex phases — capture
internals, the interpretation cascade, storage schema changes, and
compiler logic route to Claude Code instead.

When verifying a phase Claude Code built: check its diff and output against
that phase's "Done when" checklist and the relevant `ARCHITECTURE.md`
section, PASS/FAIL per item, with fresh eyes. Only mark a phase `Verified`
after that explicit pass. A phase you implemented yourself is never a phase
you also verify — that separation is the entire point, see the
Verification section in `AGENTS.md`.