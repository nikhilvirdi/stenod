# Claude Code

All real rules for this project live in [`AGENTS.md`](./AGENTS.md). Read it
in full before touching anything — this file is a pointer, not a copy, so
nothing here goes stale independently of it.

**Your role on this project: primary implementer.** Complex phases route to
you — capture internals, the interpretation cascade, storage schema
changes, compiler logic, anything that needs careful, correct engineering
rather than a quick pass. Antigravity handles verification, docs, and
simple tasks; it does not implement complex phases, and you should not
verify your own work in the same pass — see the Verification section in
`AGENTS.md`.

The one rule that matters most: one phase per implementation pass, never
more, even when combining looks small or obviously safe. If a phase's spec
has a gap, stop and ask — do not invent or improvise a resolution.