# Spike Capture-Surfaces Reference

Consolidated findings from Phase 15.1 (Claude Code hook payload spike) and
Phase 15.2 (Antigravity brain-folder spike). Referenced by WORKPLAN.md's
15.1 and 15.2 Verify steps, and cited by every capture phase from
Milestone 19 onward.

## Claude Code (Tier A)

**Findings:**
- SessionStart: thin — session_id, transcript_path, cwd, source ("startup" | "compact"), model. No reasoning content.
- PostToolUse: full tool_input + tool_response, including raw Bash stdout/stderr. Real signal.
- Stop: includes last_assistant_message (full text of Claude's final reply). No user-side prompt text.
- PreCompact: signal-only — trigger ("manual"|"auto") + custom_instructions. No transcript/context payload.
- No git_branch field in any event — confirms §7.2 fallback (read .git/HEAD directly) is required, not optional.
- GAP: no hook payload contains the user's own prompt text, in any event. Only Claude's output
  (Stop) and tool activity (PostToolUse) are captured. User intent is only recoverable by
  separately parsing transcript_path (JSONL). Any design assuming hooks alone capture
  full conversational context is wrong — flag against ARCHITECTURE.md before build phases
  that depend on this.

## Google Antigravity (Tier B)

**Findings:**
- transcript.jsonl (at antigravity-ide/brain/<id>/.system_generated/logs/)
  contains full verbatim USER_INPUT.content — solves the user-prompt-text
  gap found in Claude Code's hooks (see 15.1).
- MODEL PLANNER_RESPONSE steps include a full `thinking` field — richer
  reasoning trace than any Claude Code hook payload provides.
- tool_calls carry full args, same richness as PostToolUse.
- EPHEMERAL_MESSAGE system-reminder blocks repeat verbatim on most turns —
  noise, must be filtered during parsing, not treated as signal.
- step_index has gaps in the raw file — parser must not assume dense
  sequential indices.
- implementation_plan.md / task.md / walkthrough.md are conditional, not
  guaranteed per conversation — this session had neither, only the JSONL
  transcripts existed.
- Correct real path is ~/.gemini/antigravity-ide/brain/<id>/ when running
  inside the IDE, not ~/.gemini/antigravity/brain/ as originally assumed
  in ARCHITECTURE.md §7.1 — needs a correction there.
