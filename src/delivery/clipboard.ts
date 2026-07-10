import clipboard from 'clipboardy';
import type { CompiledManifest } from '../compiler/index.js';

/**
 * Phase 9.1 — Clipboard Delivery
 *
 * SSOT §6.5: "Clipboard copy is the guaranteed path — zero dependency on
 * anything being reachable, the entire point of the project."
 *
 * Serialization choice (documented for review, confirmed by explicit user
 * decision — neither SSOT nor WORKPLAN defines a text/prose template for
 * the Handoff Manifest anywhere): the compiled manifest is copied as
 * `JSON.stringify(manifest)`, reusing the exact serialization already
 * established in this codebase as a compiled manifest's canonical "bytes"
 * (Phase 8.8's determinism tests). No new formatting/template logic is
 * invented here.
 *
 * Do NOT write to `manifest_log` here — that remains Phase 9.2's
 * responsibility (SSOT §6.5: "Every compiled manifest is logged... before
 * delivery," a separate write path from this one).
 */
export async function copyManifestToClipboard(manifest: CompiledManifest): Promise<void> {
  await clipboard.write(JSON.stringify(manifest));
}
