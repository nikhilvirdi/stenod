// Capture module — Phase 4.1 (watcher) and later.
export { createWatcher, loadGitignoreRules, isIgnoredByGitignore, buildIgnorePredicate } from './watcher.js';
export type { WatcherOptions } from './watcher.js';

// Phase 4.2 — AST parsing.
export { createAstParser, detectLanguage } from './ast-parser.js';
export type { AstLanguage, AstNode, AstParser } from './ast-parser.js';

// Phase 4.3 — constraint comment syntax parser.
export { extractConstraintComments } from './constraint-comment.js';
export type { ConstraintComment } from './constraint-comment.js';

// Phase 4.4 — FILE_STATE node creation + graph write.
export { writeFileStateNode, createFileStateCapture } from './file-state.js';
export type { FileStateWriteResult } from './file-state.js';

// Phase 4.5 — secret redaction (filesystem). Reused by Phase 5.5 for terminal output.
export { redactSecrets, REDACTED_PLACEHOLDER } from './redaction.js';

// Phase 5.1 — node-pty shell wrapper.
export { TerminalWrapper } from './terminal.js';
export type { TerminalWrapperOptions } from './terminal.js';

// Phase 5.2 — Batching + Backpressure.
export { TerminalBatcher } from './batcher.js';
export type { BatcherOptions } from './batcher.js';

// Phase 5.3 — exit-code signal -> TERMINAL_SUCCESS/TERMINAL_ERROR node creation.
export { writeTerminalNode, createTerminalCapture } from './terminal-state.js';
export type {
  TerminalNodeType,
  TerminalWriteResult,
  TerminalCaptureOptions,
} from './terminal-state.js';

// Phase 5.4 — long-running process stderr heuristic.
export { looksLikeCrash, writeHeuristicCrashNode, HEURISTIC_CRASH_TAG } from './terminal-heuristic.js';

// Phase 6.1 — ingestion queue ("the Bouncer"): single serialized write path
// merging filesystem and terminal event streams. Standalone in this phase —
// wiring file-state.ts/terminal-state.ts writes through it is Phase 7.2.
export { IngestionQueue } from './queue.js';
export type { QueueTask } from './queue.js';
