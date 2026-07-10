import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CompiledManifest } from '../compiler/index.js';

/**
 * Phase 9.2 — `manifest_log` Write
 *
 * SSOT §6.5: "Every compiled manifest is logged (manifest_log) before
 * delivery." WORKPLAN Build line: "every compiled manifest writes a row
 * (node IDs, token count, null outcome) before delivery."
 *
 * Design decisions (documented for review):
 * -----------------------------------------------------------------------
 * - "Node IDs" = every node actually selected into the manifest, i.e. the
 *   primacy zone (CONSTRAINT nodes) plus the middle zone (packed causal
 *   graph) — matching the manifest_log schema comment itself ("JSON array
 *   of node IDs selected into this manifest," SSOT §6.2). The recency zone
 *   carries no node IDs (it's resume text / a Next Actions message, not
 *   selected nodes), so it's excluded from this computation.
 * - "Token count" = the sum of `tokenCost` across that same node set — the
 *   natural pairing with "node IDs" in the Build line, and the only token
 *   figure the CompiledManifest's zones actually carry per-node.
 * - `outcome` is always written as `NULL` at this stage — Phase 9.3
 *   ("--worked"/"--failed" updates the outcome column on the most recent
 *   row) is explicitly the only phase that ever sets it.
 * - `id` uses `crypto.randomUUID()`, matching the established convention
 *   already used for non-content-derived table IDs elsewhere in this
 *   codebase (Phase 3.3's `resolveLwwConflict()` for `graph_edges.id`) —
 *   `graph_nodes.id` is a content hash, but nothing about manifest_log
 *   rows is content-derived, so that convention doesn't apply here.
 * - `nowMs` is an optional parameter defaulting to `Date.now()`, the same
 *   deterministic-testing convention already used by Phase 3.4's
 *   `rejectSince()` and Phase 8.9's `compileManifest()`.
 * - This function performs ONLY the `manifest_log` write — it does not
 *   call `copyManifestToClipboard` (Phase 9.1) itself. SSOT's "before
 *   delivery" describes a call-ORDER requirement for whatever eventually
 *   orchestrates a real handoff (Phase 10.4, "Wire `stenod handoff`,"
 *   which this phase doesn't depend on and doesn't have a CLI framework
 *   available to yet) — not a mandate for this phase to build that
 *   orchestrator itself. This phase's own test demonstrates the correct
 *   ordering (log write, then delivery) without shipping a combined
 *   wrapper function that isn't part of its Build line.
 */

export interface ManifestLogEntry {
  id: string;
  createdAt: number;
  nodeIds: string[];
  tokenCount: number;
  outcome: null;
}

/**
 * Writes one `manifest_log` row for `manifest`: every node ID selected
 * into the primacy and middle zones, their summed token cost, and a NULL
 * outcome (set later, if ever, by Phase 9.3's feedback tagging).
 */
export function writeManifestLogEntry(
  db: Database.Database,
  manifest: CompiledManifest,
  nowMs: number = Date.now()
): ManifestLogEntry {
  const includedNodes = [...manifest.primacyZone, ...manifest.middleZone];
  const nodeIds = includedNodes.map((node) => node.id);
  const tokenCount = includedNodes.reduce((sum, node) => sum + node.tokenCost, 0);
  const id = randomUUID();

  db.prepare(
    `INSERT INTO manifest_log (id, created_at, node_ids, token_count, outcome)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, nowMs, JSON.stringify(nodeIds), tokenCount, null);

  return { id, createdAt: nowMs, nodeIds, tokenCount, outcome: null };
}
