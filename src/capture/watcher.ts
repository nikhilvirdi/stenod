/**
 * Phase 4.1 — chokidar Watcher + Ignore-List
 *
 * SSOT §6.1: chokidar watches the project directory.
 * Excludes:
 *   - .env
 *   - .git/
 *   - node_modules/
 *   - common build output dirs: dist/, build/, target/, .next/
 *   - anything the project's own .gitignore already excludes
 *   - binaries over 500 KB
 *
 * Do NOT wire into graph_nodes or the FSM here — that is Phase 4.4.
 * This module is pure path filtering + watcher lifecycle only.
 */

import { watch, type FSWatcher } from 'chokidar';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// ── Constants ────────────────────────────────────────────────────────────────

/** 500 KB binary threshold (SSOT §6.1). */
const MAX_BINARY_BYTES = 500 * 1024;

/**
 * Hard-coded exclusion list that applies unconditionally, regardless of
 * .gitignore content.  Path segments (no leading slash) — these are matched
 * against every segment in the relative path of a watched file.
 */
const HARD_EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.next',
]);

/**
 * Hard-coded exclusion list for exact filenames at any depth.
 */
const HARD_EXCLUDED_FILENAMES: ReadonlySet<string> = new Set(['.env']);

// ── Gitignore parsing ────────────────────────────────────────────────────────

/**
 * A single parsed .gitignore rule.
 * We implement a minimal subset of the gitignore spec sufficient for
 * real-world use without adding a dependency not in the Locked Technology
 * Decisions table (WORKPLAN §"Locked Technology Decisions").
 *
 * Supported:
 *   - Blank lines and # comments → ignored
 *   - Leading ! negation
 *   - Leading / anchors the pattern to the root
 *   - Trailing / means directory-only match
 *   - ** for any number of path segments
 *   - * for any characters within a single segment
 *   - ? for exactly one character within a segment
 */
interface GitignoreRule {
  /** Raw, cleaned pattern (leading/trailing whitespace stripped). */
  raw: string;
  /** If true, this rule re-includes rather than excludes. */
  negate: boolean;
  /** If true, pattern is anchored to the repository root. */
  anchored: boolean;
  /** If true, only matches directories. */
  dirOnly: boolean;
  /** Regex compiled from the pattern. */
  regex: RegExp;
}

/**
 * Convert a single gitignore pattern string into a GitignoreRule.
 * Returns null for blank lines and comments.
 */
function parseGitignoreLine(line: string): GitignoreRule | null {
  // Strip trailing whitespace (but not escaped trailing space "\\ ").
  const trimmed = line.replace(/(?<!\\)\s+$/, '');

  // Blank lines and comment lines are ignored.
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  let pattern = trimmed;
  const negate = pattern.startsWith('!');
  if (negate) pattern = pattern.slice(1);

  // A leading backslash escapes a leading # or !.
  if (pattern.startsWith('\\')) pattern = pattern.slice(1);

  const dirOnly = pattern.endsWith('/');
  if (dirOnly) pattern = pattern.slice(0, -1);

  // Anchored = contains a slash somewhere before the final character.
  // "foo" matches anywhere; "/foo" or "foo/bar" only matches from root.
  const anchored = pattern.includes('/');
  // Strip a leading slash for the regex conversion.
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  const regex = gitignorePatternToRegex(pattern, anchored);
  return { raw: trimmed, negate, anchored, dirOnly, regex };
}

/**
 * Convert a gitignore pattern (after prefix stripping) to a RegExp that
 * matches POSIX-style relative paths (forward slashes, no leading slash).
 */
function gitignorePatternToRegex(pattern: string, anchored: boolean): RegExp {
  // Split by ** first so we can handle them separately.
  const parts = pattern.split('**');
  const escapedParts = parts.map((part) =>
    part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials
      .replace(/\*/g, '[^/]*') // * → match anything except /
      .replace(/\?/g, '[^/]'), // ? → match exactly one non-/ char
  );
  const body = escapedParts.join('.*'); // ** → match anything including /

  if (anchored) {
    // Must match from the start of the relative path.
    return new RegExp(`^${body}(/.*)?$`);
  } else {
    // Can match at any segment boundary.
    return new RegExp(`(^|/)${body}(/.*)?$`);
  }
}

/**
 * Load and parse the .gitignore file in projectRoot.
 * Returns an empty array if no .gitignore exists.
 */
export function loadGitignoreRules(projectRoot: string): GitignoreRule[] {
  const gitignorePath = join(projectRoot, '.gitignore');
  if (!existsSync(gitignorePath)) return [];

  return readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .map(parseGitignoreLine)
    .filter((r): r is GitignoreRule => r !== null);
}

/**
 * Test a relative path (POSIX separators, no leading slash) against the
 * full set of gitignore rules.  Rules are applied in order; later rules
 * take precedence (standard git behaviour).
 */
export function isIgnoredByGitignore(
  relativePosixPath: string,
  rules: GitignoreRule[],
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(relativePosixPath)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

// ── Core ignore predicate ────────────────────────────────────────────────────

/**
 * Build the ignore predicate passed to chokidar's `ignored` option.
 *
 * chokidar v5 calls this function for every path it discovers.  It is
 * called frequently, so all expensive operations (file reads, gitignore
 * parsing) must be done once before calling this builder and captured in
 * closure.
 *
 * @param projectRoot  Absolute path to the project root.
 * @param gitRules     Pre-parsed gitignore rules for this project.
 */
export function buildIgnorePredicate(
  projectRoot: string,
  gitRules: GitignoreRule[],
): (filePath: string) => boolean {
  return (filePath: string): boolean => {
    // Compute path relative to projectRoot; use POSIX separators for
    // gitignore matching regardless of OS.
    const rel = relative(projectRoot, filePath);
    if (rel === '') return false; // never ignore the root itself

    const posixRel = rel.split(sep).join('/');
    const segments = posixRel.split('/');

    // ── 1. Hard-excluded directory segments ──────────────────────────────
    for (const segment of segments) {
      if (HARD_EXCLUDED_SEGMENTS.has(segment)) return true;
    }

    // ── 2. Hard-excluded exact filenames ─────────────────────────────────
    const filename = segments[segments.length - 1];
    if (HARD_EXCLUDED_FILENAMES.has(filename)) return true;

    // ── 3. .gitignore rules ───────────────────────────────────────────────
    if (isIgnoredByGitignore(posixRel, gitRules)) return true;

    // ── 4. Binary > 500 KB ────────────────────────────────────────────────
    // Only check for real files (not directories).  Wrap in try/catch
    // because the file may disappear between discovery and stat.
    try {
      const st = statSync(filePath);
      if (st.isFile() && st.size > MAX_BINARY_BYTES) return true;
    } catch {
      // File gone or not accessible — let chokidar decide.
    }

    return false;
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Options accepted by createWatcher. */
export interface WatcherOptions {
  /**
   * Called whenever a watched file is added or changed.
   * Receives the absolute path of the file.
   */
  onChange: (filePath: string) => void;

  /**
   * Called when a watched file is deleted.
   * Receives the absolute path of the file.
   */
  onUnlink?: (filePath: string) => void;
}

/**
 * Create and start the chokidar watcher for the given project root.
 *
 * Exclusion policy (SSOT §6.1):
 *   - .env (any depth)
 *   - .git/, node_modules/, dist/, build/, target/, .next/
 *   - Anything matched by the project's .gitignore
 *   - Files >500 KB (binary threshold)
 *
 * @param projectRoot  Absolute path to the project root directory.
 * @param options      Callbacks for file events.
 * @returns            The chokidar FSWatcher instance (call .close() to stop).
 */
export function createWatcher(
  projectRoot: string,
  options: WatcherOptions,
): FSWatcher {
  const gitRules = loadGitignoreRules(projectRoot);
  const ignorePredicate = buildIgnorePredicate(projectRoot, gitRules);

  const watcher = watch(projectRoot, {
    ignored: ignorePredicate,
    persistent: false, // tests don't need a long-running handle
    ignoreInitial: true, // only fire on real changes, not on startup scan
    awaitWriteFinish: {
      stabilityThreshold: 80,
      pollInterval: 10,
    },
  });

  watcher.on('add', (filePath) => options.onChange(filePath));
  watcher.on('change', (filePath) => options.onChange(filePath));

  if (options.onUnlink) {
    const cb = options.onUnlink;
    watcher.on('unlink', (filePath) => cb(filePath));
  }

  return watcher;
}
