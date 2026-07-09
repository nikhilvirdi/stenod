---
description: Resume work after a session gap — reads status, tells you what's next
allowed-tools: Read, Grep, Glob, Bash(git log*), Bash(git status)
---

Read WORKPLAN.md's Master Status Tracker and STENOD_SSOT.md's Appendix
(§14) in full.

Report, concisely:
1. The last phase marked `Verified`, and the git log entry that matches it.
2. Every phase currently `Built (unverified)`, in dependency order.
3. The next `Not Started` phase whose dependencies are all `Verified`.
4. Anything in git status that looks uncommitted or stray.

Do not start implementing or verifying anything yet — just report the
above and wait for me to say which one to do next.