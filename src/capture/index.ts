// Capture module — Phase 4.1 (watcher) and later.
export { createWatcher, loadGitignoreRules, isIgnoredByGitignore, buildIgnorePredicate } from './watcher.js';
export type { WatcherOptions } from './watcher.js';

// Phase 4.2 — AST parsing.
export { createAstParser, detectLanguage } from './ast-parser.js';
export type { AstLanguage, AstNode, AstParser } from './ast-parser.js';

// Phase 4.3 — constraint comment syntax parser.
export { extractConstraintComments } from './constraint-comment.js';
export type { ConstraintComment } from './constraint-comment.js';

// Phase 5.1 — node-pty shell wrapper.
export { TerminalWrapper } from './terminal.js';
export type { TerminalWrapperOptions } from './terminal.js';
