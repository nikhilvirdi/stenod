# Stenod

## The problem

AI-assisted coding sessions collapse at boundaries: rate limits, provider outages, context-window exhaustion, or just switching tools mid-task. What's lost isn't the chat log — it's the *reasoning*: which decisions were made and why, what was tried and rejected, which constraints are still active, and what you were mid-way through doing.

Every existing memory tool (Mem0, Zep, Letta, Cursor Notepads, etc.) is **in-band** — it requires the AI/agent to be alive and reachable to read or write memory. None of them are built around the moment the AI itself is unreachable.

## Stenod

Stenod is a local, deterministic, out-of-band daemon that captures the causal history of a coding session — file changes, terminal outcomes, and (optionally) AI-provider network traffic — and compiles it into a **Handoff Manifest** the moment you need to resume in any AI tool, including one you weren't previously using.

Not a better memory service — a system that doesn't share a failure domain with the AI it's recording.

## What it offers

- **Zero-trust by default** — watches your filesystem and terminal with no cert install, no proxy, no network calls; AI-provider network capture is a separate, explicit opt-in.
- **Causal graph, not a vector store** — typed edges (`REPLACES`, `CONTRADICTS`, `DEPENDS_ON`) so it knows which decision is *still true*, not just which ones sound similar.
- **FSM-based intent tracking** driven only by shell exit codes and file saves — never by parsing AI conversation text.
- **Automatic conflict resolution** — contradicting constraints are resolved last-writer-wins, not both silently handed to your next session.
- **Deterministic, token-budgeted manifest compiler** — a U-shaped structure (constraints → causal graph → next actions) that exploits transformer primacy/recency attention bias.
- **Clipboard-first delivery** — zero dependency on anything being reachable; an optional MCP tool lets an already-reachable agent pull the manifest directly.
- **Fully local and open source** — no telemetry, no cloud dependency, no embeddings, no LLM calls during normal operation.