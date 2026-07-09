/**
 * Phase 4.3 — Constraint Comment Syntax Parser Tests
 *
 * SSOT §6.2 / WORKPLAN Phase 4.3 "Done when" checklist:
 *   [x] Correctly extracts key/value from a valid constraint comment
 *   [x] Ignores ordinary comments that don't match the pattern
 *
 * Two layers, matching the phase's Verify line ("fixture file with both
 * constraint and non-constraint comments"):
 *   1. Unit tests against hand-built AstNode trees — fast, exercises the
 *      walk/regex logic in isolation without spinning up the Phase 4.2
 *      worker.
 *   2. An end-to-end test that parses a real JS fixture through the actual
 *      Phase 4.2 createAstParser() and extracts from its real output.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { extractConstraintComments } from './constraint-comment.js';
import type { ConstraintComment } from './constraint-comment.js';
import { createAstParser } from './ast-parser.js';
import type { AstNode, AstParser } from './ast-parser.js';

/** Minimal AstNode builder for hand-built fixture trees. */
function node(type: string, text: string, children: AstNode[] = []): AstNode {
  return { type, text, startIndex: 0, endIndex: text.length, children };
}

describe('capture/constraint-comment — Phase 4.3', () => {
  // ── Unit tests against hand-built trees ─────────────────────────────────

  it('extracts key/value from a valid constraint comment', () => {
    const root = node('program', '', [
      node('comment', '// VCS: constraint[db]=postgres'),
    ]);

    const results = extractConstraintComments(root);
    expect(results).toEqual<ConstraintComment[]>([
      { key: 'db', value: 'postgres', startIndex: 0, endIndex: 31 },
    ]);
  });

  it('ignores an ordinary comment that does not match the pattern', () => {
    const root = node('program', '', [node('comment', '// just a regular comment')]);

    expect(extractConstraintComments(root)).toEqual([]);
  });

  it('ignores comments that mention VCS/constraint without matching the exact syntax', () => {
    const root = node('program', '', [
      node('comment', '// VCS constraint[key]=value'), // missing colon
      node('comment', '// VCS: constraint key = value'), // missing brackets/equals shape
      node('comment', '// this mentions VCS and constraint but is not the syntax'),
      node('comment', '/* VCS: constraint[key]=value */'), // block comment, not `//`
    ]);

    expect(extractConstraintComments(root)).toEqual([]);
  });

  it('is tolerant of extra whitespace around the marker and inside the brackets', () => {
    const root = node('program', '', [
      node('comment', '//   VCS:   constraint[ key ]=  value with spaces  '),
    ]);

    const results = extractConstraintComments(root);
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe('key');
    expect(results[0]!.value).toBe('value with spaces');
  });

  it('finds constraint comments nested arbitrarily deep in the tree', () => {
    const root = node('program', '', [
      node('function_declaration', '', [
        node('statement_block', '', [node('comment', '// VCS: constraint[nested]=yes')]),
      ]),
    ]);

    expect(extractConstraintComments(root)).toEqual([
      { key: 'nested', value: 'yes', startIndex: 0, endIndex: 30 },
    ]);
  });

  it('extracts multiple constraint comments and skips non-matching ones in between', () => {
    const root = node('program', '', [
      node('comment', '// VCS: constraint[a]=1'),
      node('comment', '// unrelated'),
      node('comment', '// VCS: constraint[b]=2'),
    ]);

    const results = extractConstraintComments(root);
    expect(results.map((r) => [r.key, r.value])).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('handles a source file with no comments at all', () => {
    const root = node('program', '', [node('lexical_declaration', 'const x = 1;')]);
    expect(extractConstraintComments(root)).toEqual([]);
  });

  // ── End-to-end: real Phase 4.2 parser + real fixture source ────────────

  describe('end-to-end against the real Phase 4.2 parser', () => {
    let parser: AstParser | undefined;

    afterEach(async () => {
      if (parser) {
        await parser.close();
        parser = undefined;
      }
    });

    it('extracts constraint comments from real parsed source, ignoring ordinary comments', async () => {
      parser = createAstParser();
      const fixture = [
        '// VCS: constraint[key]=value',
        'const x = 1;',
        '// this is an ordinary comment',
        'function foo() {',
        '  // VCS: constraint[db]=postgres',
        '  return 1;',
        '}',
        '// not a constraint: VCS but malformed',
        '// VCSconstraint[bad]=nope',
      ].join('\n');

      const root = await parser.parse(fixture, 'javascript');
      const results = extractConstraintComments(root);

      expect(results.map((r) => [r.key, r.value])).toEqual([
        ['key', 'value'],
        ['db', 'postgres'],
      ]);
    });
  });
});
