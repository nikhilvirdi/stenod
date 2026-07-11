import type Database from 'better-sqlite3';
import type { NodeType, NodeStatus } from '../storage/index.js';
import type { FsmState } from '../lifecycle/index.js';
import { countTokens } from './tokenizer.js';
import { calculateUtilityScore } from './utility-score.js';
import { calculateCausalCentrality } from './causal-centrality.js';
import { packByGreedyRatio } from './greedy-packing.js';
import type { PackableNode } from './greedy-packing.js';
import { applyLocalImprovementPass } from './local-improvement.js';
import { assembleUShapedManifest } from './u-shaped-manifest.js';
import type { UShapedManifest } from './u-shaped-manifest.js';
import { withNextActionsBlock } from './next-actions.js';
import type { RecencyZoneWithNextActions } from './next-actions.js';

/**
 * Phase 8.9 — DB-to-Manifest Orchestrator
 *
 * SSOT §6.2, §6.4. WORKPLAN Build line: closes the gap left by Phases
 * 8.1-8.8, none of which wire the compilation pipeline to real
 * `graph_nodes`/`graph_edges` rows. This is that wiring, and nothing else —
 * every actual computation (token cost, causal centrality, utility score,
 * packing, local improvement, U-shape assembly, Next Actions) is delegated
 * to its own already-built phase; this file only fetches rows and calls
 * them in order.
 *
 * Design decisions (documented for review):
 * -----------------------------------------------------------------------
 * - **`ORDER BY event_id ASC`**, not `id` or `created_at`. `event_id` is
 *   documented (storage/index.ts `nextEventId`) as "monotonic, for WAL
 *   crash recovery ordering" — the one column purpose-built to be a
 *   strictly-increasing, tie-free per-insert sequence. `created_at` (epoch
 *   ms) can tie for nodes written in the same millisecond; `id` is a
 *   content hash with no causal meaning. This directly satisfies the
 *   phase's own Done-when item ("query includes an explicit ORDER BY") and
 *   the determinism gap flagged during Phase 8.8 verification.
 * - **`constraint_priority` derivation** (needed to call Phase 8.2's
 *   `calculateUtilityScore`, which Phase 8.2 deliberately left
 *   caller-supplied — see utility-score.ts's own header comment): resolved
 *   by explicit user decision (not invented) as `1` for `CONSTRAINT`-type
 *   nodes, `0` otherwise. This is the only DB column (`type`) with any
 *   plausible relationship to "constraint priority," and it's moot for
 *   ranking purposes anyway since Phase 8.4 force-includes CONSTRAINT nodes
 *   regardless of score — it only affects the recorded utility score value
 *   itself, never inclusion.
 * - **`resumeInstruction` and `fsmState`/`unresolvedErrorContext` stay
 *   caller-supplied parameters**, not derived from the DB. This matches
 *   Phase 8.6's and 8.7's own established scope boundaries (both
 *   explicitly took these as opaque caller-supplied content, not something
 *   they compute) — Phase 8.9's Depends-on list is 8.1-8.7 only, not 3.1 or
 *   any session-state storage, so deriving "current FSM state" from the DB
 *   would be new, unspecified behavior this phase wasn't asked to add. The
 *   Build line's own example signature `compileManifest(db, tokenBudget)`
 *   is prefixed "e.g." — illustrative, not an exhaustive parameter list.
 * - **`nowMs` is an optional parameter, defaulting to `Date.now()`** —
 *   the same convention already used by Phase 3.4's `rejectSince()` for
 *   deterministic testing of wall-clock-dependent logic. Without an
 *   explicit reference time, `decay(Δt)` (Phase 3.2, consumed by 8.2's
 *   utility score) would silently drift between two calls made at
 *   different real wall-clock moments, which would make even this phase's
 *   own Done-when determinism test fragile. Passing the *same* `nowMs` to
 *   both calls in that test is what "identical input" means for a
 *   function whose formula is partly time-based by design (CLAUDE.md
 *   permits wall-clock branching only for "the already-specified
 *   decay/timeout logic" — this is exactly that logic, threaded through
 *   explicitly rather than left implicit).
 * - Only ACTIVE rows are fetched from SQL directly (`WHERE status =
 *   'ACTIVE'`), matching Build line step (1) precisely; Phase 8.4's own
 *   internal ACTIVE filter then becomes a redundant no-op safety check, not
 *   a contradiction.
 * - Does NOT perform clipboard delivery or write to `manifest_log` — purely
 *   a read + pure-function pipeline, matching the phase's "Do NOT."
 *
 * Phase 8.10 addition — Tiered Content Inclusion Fix (SSOT §6.4 "Tiered
 * content inclusion"): the original version of this file computed each
 * node's `tokenCost` from `row.content` and then discarded `row.content`
 * entirely — every packed node carried only `{id, type, status,
 * utilityScore, tokenCost}`, so the compiled manifest, while structurally
 * correct, contained no actual resumable text. Fixed by deriving a
 * `contentPreview` per node (below, `deriveContentPreview()`) via three
 * fixed, deterministic tiers — CONSTRAINT nodes get full uncapped content;
 * `utilityScore >= 0.6` nodes get a bounded excerpt capped at 300 tokens;
 * everything else gets a fixed one-line template (never an LLM call) — and
 * `tokenCost` is now computed from that emitted `contentPreview`, not from
 * raw `row.content`, so the packing ratio math reflects what's actually
 * included. `source_file` is now selected alongside the other columns
 * because the tier-3 template needs it.
 */

export interface CompileManifestParams {
  /** Opaque resume instruction text — Phase 8.6's recency-zone content. */
  resumeInstruction: string;
  /** Current FSM state — Phase 8.7's Next Actions block trigger. */
  fsmState: FsmState;
  /** Optional descriptive content about an unresolved error (Phase 8.7). */
  unresolvedErrorContext?: string;
  /** Reference "now" for recency decay; defaults to Date.now(). Pass an explicit value for deterministic repeated calls. */
  nowMs?: number;
}

export interface CompiledManifest extends UShapedManifest {
  recencyZone: RecencyZoneWithNextActions;
}

interface ActiveNodeRow {
  id: string;
  event_id: number;
  type: NodeType;
  content: string;
  status: NodeStatus;
  source_file: string | null;
  created_at: number;
}

/**
 * SSOT §6.4 "Tiered content inclusion" — fixed constants, not configurable,
 * matching this system's static-λ determinism principle (§6.4's own
 * `λ1/λ2/λ3`, CLAUDE.md's "λ weights are static... never configurable").
 */
const TIER2_MIN_UTILITY_SCORE = 0.6;
const TIER2_EXCERPT_MAX_TOKENS = 300;

/**
 * Returns the longest prefix of `content` (by character count) whose token
 * count, per Phase 8.1's `countTokens()`, does not exceed `maxTokens`.
 * Binary search over character offsets rather than importing `gpt-tokenizer`
 * `encode`/`decode` directly here — keeps this file's only tokenizer
 * dependency the same single `countTokens()` call it already imports, so
 * `gpt-tokenizer` itself stays used from exactly one place (Phase 8.1's
 * `tokenizer.ts`) across the whole codebase.
 */
function excerptToTokenLimit(content: string, maxTokens: number): string {
  if (countTokens(content) <= maxTokens) {
    return content;
  }

  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countTokens(content.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return content.slice(0, lo);
}

/**
 * Applies SSOT §6.4's three fixed content tiers to a single node, at pack
 * time:
 *   1. `CONSTRAINT` nodes -> full, uncapped `content` (already naturally
 *      short — a rule or decision line — so no truncation is applied).
 *   2. `utilityScore >= TIER2_MIN_UTILITY_SCORE` -> a bounded excerpt of
 *      `content`, capped at `TIER2_EXCERPT_MAX_TOKENS` tokens.
 *   3. Everything else -> a fixed, deterministic one-line template
 *      (`"{type} in {source_file}"`, or `"{type}"` if `source_file` is
 *      null) — never an LLM call or free-form summarization, preserving
 *      SSOT §9's zero-LLM-dependency guarantee.
 */
function deriveContentPreview(
  type: NodeType,
  utilityScore: number,
  content: string,
  sourceFile: string | null
): string {
  if (type === 'CONSTRAINT') {
    return content;
  }
  if (utilityScore >= TIER2_MIN_UTILITY_SCORE) {
    return excerptToTokenLimit(content, TIER2_EXCERPT_MAX_TOKENS);
  }
  return sourceFile ? `${type} in ${sourceFile}` : `${type}`;
}

/**
 * Compiles a full Handoff Manifest directly from a live `graph_nodes` /
 * `graph_edges` database: fetches ACTIVE nodes in deterministic
 * (`event_id`) order, computes each node's token cost (8.1), causal
 * centrality (8.3), and utility score (8.2), then runs greedy-by-ratio
 * packing (8.4), the local improvement pass (8.5), and U-shaped assembly
 * with the Next Actions block (8.6, 8.7).
 */
export function compileManifest(
  db: Database.Database,
  tokenBudget: number,
  params: CompileManifestParams
): CompiledManifest {
  const nowMs = params.nowMs ?? Date.now();

  const rows = db
    .prepare(
      `SELECT id, event_id, type, content, status, source_file, created_at
       FROM graph_nodes
       WHERE status = 'ACTIVE'
       ORDER BY event_id ASC`
    )
    .all() as ActiveNodeRow[];

  const packable: PackableNode[] = rows.map((row) => {
    const deltaTSeconds = (nowMs - row.created_at) / 1000;
    const causalCentrality = calculateCausalCentrality(db, row.id).total;
    const constraintPriority = row.type === 'CONSTRAINT' ? 1 : 0;

    const utilityScore = calculateUtilityScore({
      deltaTSeconds,
      causalCentrality,
      constraintPriority,
    });

    const contentPreview = deriveContentPreview(row.type, utilityScore, row.content, row.source_file);

    return {
      id: row.id,
      type: row.type,
      status: row.status,
      utilityScore,
      contentPreview,
      tokenCost: countTokens(contentPreview),
    };
  });

  const packed = packByGreedyRatio(packable, tokenBudget);
  const improved = applyLocalImprovementPass(packed, tokenBudget);
  const manifest = assembleUShapedManifest(improved, params.resumeInstruction);

  const recencyZone = withNextActionsBlock(manifest.recencyZone, {
    fsmState: params.fsmState,
    unresolvedErrorContext: params.unresolvedErrorContext,
  });

  return { ...manifest, recencyZone };
}
