import type { PackableNode } from './greedy-packing.js';
import type { LocalImprovementResult } from './local-improvement.js';

/**
 * Phase 8.6 — U-Shaped Output Structuring
 *
 * SSOT §6.4: "Output structure (U-shaped): constraints (primacy zone) →
 * packed causal graph (middle) → exact resume instruction plus the 'Next
 * Actions' block, derived from the FSM's current unresolved state
 * (recency zone)."
 *
 * WORKPLAN Build line for this phase covers only the first two zones plus
 * a bare "resume instruction" — the FSM-derived "Next Actions" content is
 * explicitly Phase 8.7's separate scope ("surface the FSM's current
 * unresolved state... as an explicit block in the recency zone," Depends
 * on: 8.6, 3.1 — a real FSM dependency 8.6 itself does not have).
 *
 * Scope note / interpretation choice (documented for review): neither
 * SSOT nor WORKPLAN defines how "resume instruction" text is derived —
 * unlike the "Next Actions" block, there's no formula, template, or FSM
 * reference given for it here, and this phase's own Verify line ("unit
 * test asserting zone ordering") is about structure, not content. This
 * phase therefore takes `resumeInstruction` as an opaque, caller-supplied
 * string rather than inventing how to generate it — this phase's job is
 * the U-shape assembly (which nodes go in which zone, in which order),
 * not authoring recency-zone prose. `RecencyZone` is a small object
 * (rather than a bare string) specifically so Phase 8.7 can extend it with
 * an additional field of its own without needing to change this file.
 *
 * "Packed causal graph (middle)" is derived from Phase 8.5's
 * `LocalImprovementResult.included` by filtering out CONSTRAINT nodes
 * (which go to the primacy zone instead) — not by any positional
 * assumption about how 8.4/8.5 order that array internally, so this stays
 * correct even if those phases' internal ordering ever changes.
 */

export interface RecencyZone {
  resumeInstruction: string;
}

export interface UShapedManifest {
  /** CONSTRAINT nodes — always first, regardless of score (SSOT's primacy zone). */
  primacyZone: PackableNode[];
  /** The packed, locally-improved causal graph — SSOT's middle zone. */
  middleZone: PackableNode[];
  /** Resume instruction (+ Phase 8.7's future "Next Actions" block) — SSOT's recency zone. */
  recencyZone: RecencyZone;
}

/**
 * Assembles a Phase 8.5 result and a resume instruction into the final
 * three-zone U-shaped structure: constraints (primacy) -> packed causal
 * graph (middle) -> resume instruction (recency).
 */
export function assembleUShapedManifest(
  packResult: LocalImprovementResult,
  resumeInstruction: string
): UShapedManifest {
  const primacyZone = packResult.included.filter((node) => node.type === 'CONSTRAINT');
  const middleZone = packResult.included.filter((node) => node.type !== 'CONSTRAINT');

  return {
    primacyZone,
    middleZone,
    recencyZone: { resumeInstruction },
  };
}
