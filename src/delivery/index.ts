// Delivery module boundary — implementation begins in Phase 9.x

// Phase 9.1 — Clipboard delivery: copies the compiled manifest (JSON-serialized) to the system clipboard.
export { copyManifestToClipboard } from './clipboard.js';

// Phase 9.2 — manifest_log write: logs every compiled manifest's node IDs + token count (outcome NULL) before delivery.
export { writeManifestLogEntry } from './manifest-log.js';
export type { ManifestLogEntry } from './manifest-log.js';
