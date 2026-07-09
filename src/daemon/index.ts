// Phase 7.1 — `stenod init`: workspace sandbox + auth token + service unit generation.
export { stenodInit } from './init.js';
export type { StenodInitOptions, StenodInitResult } from './init.js';

// Phase 7.2 — `stenod start` / `stenod stop`: wires the fs + terminal
// capture tracks through one shared IngestionQueue into a running process.
export { startDaemon, stopDaemon } from './lifecycle.js';
export type { StartDaemonOptions, StopDaemonOptions, DaemonHandle } from './lifecycle.js';

// Phase 7.3 — `stenod status`: reads daemon health, node count, and last
// event timestamp directly from on-disk state (PID lock + SQLite DB).
export { getDaemonStatus } from './status.js';
export type { DaemonStatus } from './status.js';
