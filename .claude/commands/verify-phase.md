---
description: Verify a Built-but-unverified phase against WORKPLAN.md — run this from a fresh session/context, not the one that implemented it
argument-hint: [phase number, e.g. 4.1]
allowed-tools: Read, Grep, Glob, Bash(npm test*), Bash(npm run lint*), Bash(npx tsc --noEmit*), Bash(git diff*), Bash(git log*)
---

Verify phase $ARGUMENTS, currently `Built (unverified)` in WORKPLAN.md's
Master Status Tracker.

Per AGENTS.md, Antigravity is this project's primary verifier when
Claude Code was the implementer — prefer routing there first. This
command exists as the sanctioned fallback for a genuinely fresh,
same-tool session when that's not available; it only counts as real
verification if this session has no memory of implementing the phase
itself.

Do not assume anything from prior conversation — treat this as a cold
review, since the point of this pass is fresh eyes.

1. Read that phase's full entry in WORKPLAN.md (Build / Do NOT / Done
   when / Verify) and the ARCHITECTURE.md section(s) it references.
2. Inspect the actual code and tests for this phase directly (`git
   log`, `git diff`, or reading the relevant files) — don't take a
   summary's word for it.
3. Run the phase's own tests and confirm they pass for real, not just
   that they exist.
4. Report PASS or FAIL for every individual "Done when" checklist item
   — not one overall verdict.
5. Flag anything that looks like drift from ARCHITECTURE.md even if it
   isn't explicitly on the checklist, especially any file touched
   outside this phase's stated scope.

Only if every item is a clean PASS: update this phase's row in
WORKPLAN.md's Master Status Tracker to `Verified`, and remind me to
make the git commit for it (`git commit -m "Phase $ARGUMENTS: <name>"`).

If anything fails: report exactly what failed and why, and leave the
status as `Built (unverified)` — do not attempt to fix it in this same
pass.