## Stenod : Architecture & Design

This document describes how Stenod was designed, what was built from that design, and what testing showed. It is the reference for the intended architecture and for the reasons behind it. Each section states what was built and what was not. The project is closed, and the testing findings are summarized in the README.

Version 1.0 was implemented. Its filesystem capture, terminal capture through the attach command, CLI commands, storage layer, and compiler ran during testing. Most of version 2.0 was never built. Two research spikes were completed, and one schema change was written. The tool integrations, the interpretation layer, the scoreboard, and the delta handoff were never started. In testing, the handoff failed its main purpose: file entries carried only filenames, so a cold agent could not resume from them.

### Table of Contents

1. [The Problem](#the-problem)
2. [Existing Solutions](#existing-solutions)
3. [What Stenod Was Meant to Be](#what-stenod-was-meant-to-be)
4. [The Handoff Contract](#the-handoff-contract)
5. [Features and Status](#features-and-status)
6. [Interfaces](#interfaces)
7. [System Design](#system-design)
8. [Tech Stack](#tech-stack)
9. [Design Trade-offs](#design-trade-offs)
10. [Scope and Limitations](#scope-and-limitations)
11. [Security, Privacy, and Trust](#security-privacy-and-trust)
12. [Evaluation Strategy](#evaluation-strategy)
13. [Cost](#cost)
14. [Design Decision Log](#design-decision-log)

### The Problem

AI-assisted coding sessions break at boundaries: rate limits, provider outages, context-window exhaustion, and a developer switching tools partway through a task. At that point, what gets lost is more than chat history. It is the reasoning behind the work: which decisions were made and why, which approaches were tried and rejected, which constraints still apply, and what the developer was in the middle of doing.

Existing tools save conversations. The design targeted the layer beneath that, the intent a conversation carries.

The failure modes the design identified fall into four groups:

- Session breaks, such as context switches, session expiry, moving between machines, and an IDE that cannot show its own chat history.
- Budget pressure, such as hidden context limits, rate limits, lossy automatic compaction, and cold cache reloads that spend usage just to rebuild context.
- Memory decay, such as stale or conflicting rule files, memory that is never rechecked, and context carried across git branches.
- Recovery failure, such as a raw history dump reviving an idea that was already rejected, or an agent re-deriving a fix that already existed.

All four come from one cause: work stops, and the reasoning does not survive the gap. A blank slate at least admits it knows nothing. A stale or partial context is more dangerous, because it lets an agent act confidently on a false premise. That risk pushed the design toward accurate current state rather than a complete archive.

Agent execution problems, such as command loops or skipped steps, were excluded. They concern an agent misbehaving with full context, not lost context.

### Existing Solutions

The table below records the design's reading of each system when it was written. These comparisons were not re-verified during testing. Treat them as the reasoning behind the design, not as established facts about those products.

| System | Approach | Limitation for this problem |
|---|---|---|
| Mem0 | Hosted and SDK-based memory for agents | Works in-band, so it depends on the agent or API being reachable |
| Zep (Graphiti) | Temporal knowledge graph over conversational facts | In-band, and models chat facts rather than codebase events |
| Letta (MemGPT) | Memory manager inside the agent loop | In-band by design |
| Supermemory | MCP-based memory aimed at coding agents | Requires the agent to make a successful tool call |
| projectmem | Event-sourced memory driven by git hooks | Scoped to one project, and does not merge concurrent agents |
| claude-mem | Hook-based capture across several tools, with AI summarization | Summaries replace the original record, and rejected decisions are not kept as first-class items |
| SpecStory | Saves agent and editor sessions as searchable markdown | An archive rather than an interpreted current state |
| Windsurf Cascade Memories, Cursor Notepads | Built into one IDE's agent | Tied to that tool, its quota, and its outages |
| Manual copy-paste | Requires no tooling | No filtering of dead ends, and large dumps are hard for models to use |
| Git | Records what changed | Does not record why, which constraints still apply, or what was rejected |

Two patterns stood out to the design. Most of these systems depend on the AI being reachable, so they fail at the same moment the AI does. The systems that span several tools either summarize rejected decisions away or leave them in an unsorted archive. The design aimed for both properties together: capture that survives an AI outage, and rejected decisions kept as first-class records with their reasons attached. Testing did not confirm the second property, because the scoreboard that would have provided it was never built.

### What Stenod Was Meant to Be

Stenod was designed as a local, deterministic daemon. It would record a project's file changes, terminal outcomes, and, where a tool allowed it, the reasoning behind an AI agent's changes. It would then compile that record into a Handoff Manifest that a developer could paste into any AI tool to resume work.

The central design goal was that the recorder would not share a failure domain with the AI it records. A recorder that depends on the AI being alive cannot help when the AI is down. Stenod was meant to keep working in that situation, and to capture one project even when several tools were working on it at once.

It was not designed as a general memory service. The design focused on one failure mode: reasoning that disappears when a session does.

The name comes from stenographer, someone who transcribes exactly what happens so another person can read it later. It also follows the Unix convention for daemon names, as in sshd and httpd.

### The Handoff Contract

The central idea was a scoreboard of current truth rather than a log. Each signal, such as a file change, a captured decision, or a rejected approach, would propose an entry in the form topic = answer. If the topic already had an entry, the newer entry would become current, and the older one would move to history. Nothing would be deleted. Old entries would keep the reason they lost.

Each entry would have one of three states:

- Settled: the standing answer to a question the project has resolved.
- Rejected: an approach that was tried or proposed and then abandoned, with the reason attached. The design kept this state first-class rather than treating it as metadata. Outside reviewers suggested demoting it, and the design kept it (see section 14).
- Open: a question that has been raised but not resolved.

The goal was that a fresh agent could see what was true, what had been tried, and why it was dropped, so it would not propose a dead idea without knowing its history.

Status: the scoreboard was never built in the running daemon. The schema includes a DECISION node type and the resolution fields, and unit tests cover them, but no live capture path writes to them. In testing, no settled, rejected, or open entries appeared from real code changes or from an unresolved architectural question. The only content that appeared came from constraints recorded by hand with `stenod anchor`.

### Features and Status

Each feature below is listed with what happened in testing. "Never built" means no code exists for it. "Ran" means the command or feature executed without recorded failures, but its output was not evaluated for quality.

| Feature | Status | Notes |
|---|---|---|
| Filesystem capture | Worked in testing | Reliable across a full build session |
| Secret exclusion | Worked in testing | Skips `.env` files, `node_modules`, files in `.gitignore`, and files over 500KB |
| Constraint recording (`stenod anchor`) | Worked in testing | Full text appears in the handoff |
| Terminal capture (`stenod attach`) | Not tested | Unix and Mac only. Records one aggregate node per shell session |
| Handoff Manifest content | Failed | File entries contained only filenames |
| Supersession of repeated edits | Failed | One file accumulated 10 identical active records |
| Time-window rejection (`stenod reject`) | Partly worked | Removed the current version of working files along with the mistake |
| Status reporting (`stenod status`) | Partly worked | Counts rejected records, so the count differs from the next handoff |
| Daemon start | Partly worked | Reports success without checking that the daemon started |
| Daemon reliability | Failed | Stopped silently on Windows, with an empty error log |
| Scoreboard (settled, rejected, open) | Never built | No live path writes decision entries |
| Typed causal graph edges | Partly built | Only `CONTRADICTS` edges are created, between constraint records |
| Compiler and U-shaped output | Ran | Output quality was limited by the capture failures above |
| Clipboard delivery | Ran | Used by `stenod handoff` |
| MCP resource (`stenod mcp`) | Ran | No failures recorded |
| Tool integrations (Claude Code, Codex, Kiro, Antigravity, Cursor) | Never built | Planned as hook and session-file capture |
| `stenod integrate` and `stenod detach` | Never built | Documented but absent from the CLI |
| Delta handoff (`--new`) | Never built | No diffing against earlier manifests exists |
| `--full` flag | Missing | Bare `handoff` already behaves as `--full` |
| Dependency-change capture | Never built | Planned to track manifest file changes as decisions |
| AI tie-breaker | Never built | No client code exists |
| Stale rule-file detection | Never built | No rule-file reader exists |
| Network capture tier | Not tested | Unix and Mac only |
| Local dashboard | Never built | Planned as a read-only view served from localhost |

Of the planned version 2.0 work, two research spikes were completed and one schema change was written. The tool integrations, the interpretation layer, the cross-tool timeline, the delta handoff, dependency capture, and stale rule-file detection were not started.

### Interfaces

The CLI was the only interface. The table lists each command, what it was meant to do, and what happened in testing. Commands that were never built are listed so the intended surface stays visible.

| Command | Intended purpose | Status |
|---|---|---|
| `stenod init [--reset]` | Set up the daemon and database for a project. `--reset` rotates the local token. | Worked |
| `stenod start [--project-root] [--foreground]` | Start the ingestion daemon, with filesystem capture by default | Worked, but did not confirm startup |
| `stenod stop` | Stop the daemon | Worked |
| `stenod status` | Report health, node count, last event, and flagged conflicts | Partly worked |
| `stenod attach` | Bridge a shell's terminal activity to the daemon, once per shell | Not tested (Unix and Mac) |
| `stenod integrate <tool>` | Opt in to structured capture for a tool, announced and reversible | Never built |
| `stenod detach <tool>` | Remove what `integrate` added and confirm the removal | Never built |
| `stenod handoff [--full \| --new]` | Compile and copy the Handoff Manifest. `--full` is the default. `--new` shows changes since the last handoff. | Partly worked. `--new` never built. |
| `stenod handoff --worked` / `--failed` | Tag the outcome of the most recent manifest | Ran |
| `stenod anchor "<text>"` | Create a constraint record | Worked |
| `stenod reject --since <duration>` | Exclude records from a time window from future manifests | Partly worked |
| `stenod enable-network-capture` / `disable-network-capture` | Opt in to AI-provider traffic capture through a local certificate authority and proxy, and undo it fully | Not tested (Unix and Mac) |
| `stenod mcp` | Serve the manifest as an MCP resource over stdio | Ran |

Terminal capture never ran inside the daemon. A detached daemon has no terminal to attach to, so capture runs through `stenod attach` in each shell that should be recorded. Clipboard delivery was the path meant to work with nothing else reachable. The MCP resource was a convenience layer on top of it.

### System Design

This section first describes what was built, then the planned capture tiers, the planned interpretation layers, and the compiler, which was built and is the part that turned records into output.

#### What Was Built

A file watcher (chokidar) observes the project directory. The file-state handler writes one node for each distinct file content, so every save with new content creates a row.

Terminal activity arrives through `stenod attach`, which reports one aggregate node when a shell session ends, not one node per command. An earlier version spawned a placeholder shell inside the daemon. Its idle prompt output polluted handoff manifests with escape codes, so terminal capture was removed from the daemon process, and `attach` became the only path.

All events enter one serialized ingestion queue, which writes to SQLite in WAL mode. When a write fails, the error is caught and discarded without a log entry. That choice kept one bad event from crashing the daemon, but it also hid write failures from the user and made the silent daemon death in testing hard to diagnose.

#### Storage

The live schema holds file-state, constraint, and terminal records, plus a manifest log that records every compiled manifest. The only edge type created in live code is `CONTRADICTS`, between constraint records that share a key. `REPLACES`, `CAUSED_BY`, and `DEPENDS_ON` exist in the schema and in test fixtures, but no live code writes them.

Because file states are keyed on a hash of their content, each distinct save creates a new row. Nothing links the newer row to the older one, so no file state is ever superseded. The planned fix is a `REPLACES` edge and a status change on each save. That fix was not built.

The 2.0 schema additions were designed in full: a DECISION node type, resolution and resolution-reason fields, a source-tool column, a git-branch column, a SHADOWED status, and a RESOLVES edge. Only the DECISION type and the resolution fields were built, and they are not used by live code. The other additions do not exist in the schema.

#### Planned Capture Tiers (Never Built)

The 2.0 design grouped coding agents into capture tiers based on what each one exposes:

- Tier A: structured lifecycle hooks, for Claude Code, Codex, and Kiro. The design planned to read events such as session start, tool use, pre-compaction, and stop, and to take the snapshot before the tool summarized its own context.
- Tier B: plaintext session artifacts, for Google Antigravity, which has no hook system. The design planned to read the session files directly.
- Tier C: a borrowed parser for Cursor's undocumented chat storage, wrapped behind a thin adapter so a format change would affect only that adapter.
- Tier 0: filesystem and terminal capture, which was built and works under any tool.

The design also planned several rules for these integrations. Hook scripts would hand their payload to the daemon and exit at once, so they could never stall the agent. Each hook would deliver an event only to a project that had a `.stenod/` folder, because tool hook configuration is global. Integration would be explicit, announced, and reversible through `integrate` and `detach`.

The capture-surface spike examined Claude Code hook payloads and Antigravity session files. It found that hook payloads did not include the user's own prompt text, only tool activity and the assistant's final message. The planned fallback was to read the transcript file for rejection reasoning. Neither the fallback nor any tier was built.

#### Interpretation (Planned, Not Built)

The design turned raw reasoning into scoreboard entries in three layers, cheapest first, with each layer allowed to abstain.

Layer 0 was meant to read structural signals from file events and command exit codes, such as a file overwrite that supersedes an earlier state or a dependency swap in a manifest file. It would reuse the finite state machine and last-writer-wins conflict resolution. Layer 1 was meant to apply deterministic text rules for rejection and decision language, using wink-nlp for sentence splitting and negation. Layer 2 was an optional AI tie-breaker that would run only at handoff time, only on ambiguous spans, on the user's own key, and never on a full transcript.

Topic identity was planned as a three-step ladder: an explicit constraint key first, then shared identifiers or referential language, and then a flag marking a possible conflict instead of a silent merge.

Status: the finite state machine and last-writer-wins code exist and have unit tests, but they are not connected to decisions. The `COMMIT` event is never fired, so the `DIFF_SUBMIT` and `PROVISIONAL_PANIC` states cannot be reached. The anti-rot timer, which was meant to reset a runtime error stuck for 600 seconds, exists and is tested, but the daemon never starts it. Layers 0 and 1 were never built, and Layer 2 has no client code.

#### Cross-Tool Timeline (Planned, Not Built)

The design treated the filesystem as the backbone. Reasoning from several agents would attach to the file event it explained, matched first by the file it referenced and only then by timestamp. Reasoning that referenced no file would stay open until a file event anchored it. Two agents writing the same file within the same second, with contradictory reasoning, would be flagged as contested rather than resolved by guesswork. No capture from more than one agent exists, so none of this was tested.

#### Compilation and Delivery

The compiler was built, and it is the part that produced the manifest in testing. It packs records with greedy-by-ratio selection, runs a local improvement pass, and arranges the output in a U-shape: settled decisions and constraints first, causal history in the middle, and next actions last. The arrangement follows research on attention in long contexts (Liu et al., *Lost in the Middle*, 2023; Xiao et al., *Efficient Streaming Language Models with Attention Sinks*, 2023).

Each record receives a utility score: 0.4 × decay + 0.4 × centrality + 0.2 × constraint priority. Records above 0.6 get a bounded excerpt of their content. Constraint records always get their full text. Everything else gets a one-line summary.

This scoring explains the empty file entries in testing. File-state nodes never receive edges, so their centrality stays at zero, and their maximum score is 0.4. They can never reach the excerpt tier. Adding `REPLACES` edges between successive file states would give them centrality and might move them past the threshold. That fix was planned, but it was not built or tested.

The `--full` view is built as the default. The `--new` view was never built, because nothing diffs a manifest against the previous one. Rejection, as built, deletes every record in a time window with no check on record type or supersession, which is why it removed the current version of working files.

Stale rule-file detection was designed but not built. The design rule was that Stenod would read a tool's instruction files and flag mismatches, but never write to them.

Delivery was designed around the clipboard as the guaranteed path, with the MCP resource as an optional layer on top. Every compiled manifest is logged before it is delivered.

### Tech Stack

The stack below is what version 1.0 used. Only the entries marked as planned were chosen for version 2.0 work.

| Area | Technology | Use |
|---|---|---|
| Runtime | Node.js 20 or later, TypeScript | Whole codebase |
| Storage | SQLite through `better-sqlite3`, WAL mode | Causal graph and manifest log |
| CLI | Commander.js | Command parsing |
| File watching | chokidar | Filesystem capture |
| Terminal bridge | node-pty | Terminal capture through `attach` |
| Code parsing | web-tree-sitter | AST parser, not called on file save |
| Tokenization | gpt-tokenizer | Token budget for packing |
| HTTPS interception | mockttp, node-forge | Opt-in AI-provider capture tier |
| Agent interface | Model Context Protocol SDK | `stenod mcp` |
| Text analysis | wink-nlp | Planned for interpretation layer 1, not built |
| Testing | Vitest | Unit and integration tests |
| Linting and formatting | ESLint, Prettier | Code style |

The project stayed on Node.js and TypeScript by design. Python was considered for stronger language tooling and rejected, because a second runtime would need a cross-process bridge, and the marginal gain did not justify that cost.

### Design Trade-offs

The design made four choices that trade one property for another.

Out-of-band recording was chosen over in-band memory. The cost is that the recorder cannot understand the reasoning on its own, so interpretation has to be deterministic or user-triggered. Testing supported the recording side, which worked for files and commands. The interpretation side was never built, so the benefit this trade-off was meant to produce was not delivered.

Deterministic rules come before AI. An AI tie-breaker runs only when the user asks for it and supplies a key. The cost is lower recall on ambiguous text, with ambiguous items left open rather than classified.

Everything stays local. Nothing leaves the machine, which makes the privacy claim checkable from the code. The cost is no remote viewing. A dashboard was planned for localhost only, and it was never built.

Rejected decisions are kept first-class. The cost is that manifests grow, which the design limited with one-line summaries. Testing showed that file states reached only the one-line tier, so the size cost was never measured with real content.

Taken together, these trade-offs favor an out-of-band recorder, and the file and terminal capture demonstrated that part. The interpretation layer that the trade-offs depend on was not built.

### Scope and Limitations

#### Never Built

- Tool integrations for Claude Code, Codex, Kiro, Antigravity, and Cursor, including the `integrate` and `detach` commands
- The settled, rejected, and open scoreboard in the running daemon
- The interpretation layers (deterministic rules and the AI tie-breaker)
- The cross-tool timeline merge
- The delta handoff (`--new`)
- Dependency-change capture
- Stale rule-file detection
- The local dashboard
- Adaptive or learned weighting of records

#### Known Failures From Testing

The README lists every failure found during testing. The most important are these. Handoff file entries carry only filenames. Repeated saves never supersede earlier records. Rejection removes working versions of files. The daemon stopped without warning during a session on Windows. `stenod start` reports success without checking that the daemon started.

#### Platform Limits

Terminal capture through `stenod attach` and the network capture tier are Unix and Mac only. On Windows, capture was limited to the filesystem. Some Unix and Mac features were not tested at all.

### Security, Privacy, and Trust

What was built:

- Secret exclusion. Files such as `.env`, the `.git` folder, `node_modules`, anything listed in `.gitignore`, and files over 500KB are kept out of capture. Testing confirmed that `.env` was never captured.
- Regex redaction as a second layer of secret protection.
- A local token generated by `stenod init` and stored in `.stenod/token`. It is a local secret, so the `.stenod` folder should never be committed or shared.
- Authenticated inter-process communication and a workspace sandbox for each project.
- The network capture tier is opt-in. It allowlists three AI-provider domains, applies two independent checks, and includes an uninstall path that removes the certificate. Code review credited the two-layer check, but the tier was not tested on Windows.

What was designed but not built:

- Rule files would be read but never written, so Stenod could not become a source of the staleness it was meant to detect.
- Tool integration would be opt-in and reversible.
- The AI tie-breaker would use only the user's key and run only at handoff time.

The design committed to zero telemetry. This was not audited separately during testing.

### Evaluation Strategy

The one evaluation tool that was built is an exact-identifier recall harness in the `src/evaluation` folder, run with `npm run evaluate`. It measures what fraction of function names, error codes, and variable names in source records also appear in the compiled manifest. It is a development tool only. The daemon, the handoff command, and the MCP resource do not use it.

The design planned to report results against two published benchmarks, LoCoMo and LongMemEval, so the numbers could be compared with other memory systems. Neither benchmark was run. Exact-identifier recall is of limited use while file entries carry only filenames, because the identifiers it counts never reach the manifest.

### Cost

Every component is a free, open-source package: Node.js, SQLite, chokidar, node-pty, web-tree-sitter, gpt-tokenizer, mockttp, node-forge, and wink-nlp. The project used no hosted database, no vector database, and no cloud model calls. The optional AI tie-breaker was designed to run on the user's own key, so any cost would fall on the user, not the project.

### Design Decision Log

This log records the design decisions and the corrections made during building and testing. The first group records corrections made during design.

| Issue | Resolution |
|---|---|
| An early spec described both a greedy compiler and a dynamic-programming packer as current | Greedy-by-ratio packing with a local improvement pass is the algorithm. The dynamic-programming packer was dropped, not partly built. |
| The storage spec disagreed on the number of tables | Three core tables. Other proposed tables were cut as outside the scope. |
| A semantic-embedding fidelity score was listed as both in scope and unvalidated | Cut. Replaced with exact-identifier recall and a reference to LoCoMo and LongMemEval. |
| Conflict resolution was described as both implemented and missing | Last-writer-wins was built as a first-class mechanism. |
| Rejection was defined by both a count and a time window | Time window (`--since`), matching session boundaries. |
| The recency decay formula was undefined at zero elapsed time | Revised to 1 / (1 + ln(1 + Δt)), which is defined at zero. |
| Capture could not see IDE-native chat panels, only browser tabs | Generalized to a local HTTPS interception proxy, opt-in only, covering any tool that makes outbound HTTPS calls. |
| The package name collided with an existing npm name | Published as `steno-daemon`. The command remains `stenod`. |
| The schema had no representation for decision state, tool provenance, or branch | Planned a DECISION node type, resolution fields, source-tool and git-branch columns, and a RESOLVES edge. The DECISION type and resolution fields were built. The rest was not. |
| No deterministic way to tell whether two decisions concern the same topic | A three-step matching ladder: explicit key, then deterministic inference, then a flag for a possible conflict. |
| Hooks and the terminal track could capture the same event | Planned a SHADOWED status, so the richer hook copy would be used and the terminal copy kept for audit. Not built. |
| Tool hook configuration is global, but daemons are per project | Planned per-project resolution inside the hook script. Not built. |

The second group records decisions to reject or defer.

| Decision | Outcome |
|---|---|
| Build a small custom model to replace the tie-breaker | Rejected. Understanding context-dependent language needs a language model, and no labeled data existed to train one. |
| Host a shared AI account for the tie-breaker | Rejected. The cost would grow with every user, which does not fit a free, personal tool. The user's own key is used instead. |
| Make AI calls silently and automatically | Rejected. Spending someone's key without a trigger breaks trust. Capture is automatic, but anything that spends or acts is user-triggered. |
| Inject the handoff into a resumed session automatically | Rejected in favor of a manual step, for consistency with the no-silent-action rule. |
| Rewrite a tool's rule files | Rejected. Stenod reads and flags them but never writes. |
| Send staleness alerts on a timer | Rejected in favor of alerts raised by events: at handoff, at status, and when a new decision contradicts a rule file. |
| Demote rejected items to metadata | Rejected. Outside reviewers suggested it twice. First-class status stayed, because it is the mechanism that stops a dead idea from being proposed again. |
| Reverse-engineer Cursor and VS Code chat storage | Rejected in favor of a maintained parser wrapped behind an adapter. |
| Use Python for stronger language tooling | Rejected. A second runtime would need a cross-process bridge. |
| Send handoff data to a hosted website, even without storing it | Rejected. "We don't store it" is a policy promise, not a structural guarantee. |
| A website with login and synced handoffs | Rejected unless the data is end-to-end encrypted. Such a service would be a separate project. |
| A browser chat capture module | Designed, then shelved. No capture path could be trusted fully, so the scope moved to terminal agents and IDEs. |

The third group records corrections made during building and testing.

| Issue | Resolution | Outcome |
|---|---|---|
| The determinism test covered the in-memory packing steps but not the database-to-manifest path | Added an orchestrator that reads from the database with an explicit ordering | Built. Determinism tests exist. |
| `start` and `stop` were designed to run in one process, but each command runs in its own process | `start` uses a detached spawn. `stop` sends a signal through the PID lock file. | Built. `start` does not confirm that the daemon started. |
| The manifest carried no node content | Tiered content: full text for constraints, excerpts above 0.6, one-line summaries otherwise | Built. Constraints appear in full. File states still fall to the one-line tier, as explained in section 7.6. |
| The placeholder shell inside the daemon put prompt escape codes into manifests | Terminal capture removed from the daemon. `attach` is the only path. | Fixed. `attach` was not tested on Windows. |
| Write failures were swallowed silently to keep the daemon running | Kept as built | Hid write failures and made daemon death hard to diagnose. Logging was planned but not built. |
| Hook payloads did not include the user's prompt text | Planned a fallback that reads the transcript file for rejection reasoning | Not built |
| The documentation described features that did not exist as working | This document and the README were rewritten to state what was built and what failed | Done |