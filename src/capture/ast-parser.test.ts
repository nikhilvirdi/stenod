/**
 * Phase 4.2 — web-tree-sitter Integration Tests
 *
 * SSOT §6.2 / WORKPLAN Phase 4.2 "Done when" checklist:
 *   [x] Parse completes correctly on valid JS/TS fixtures
 *   [x] No memory growth across repeated parse cycles (basic leak check)
 *
 * Strategy: exercise the real worker thread and real WASM grammars (no
 * mocking of web-tree-sitter internals), matching the style established by
 * watcher.test.ts for Phase 4.1.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createAstParser, detectLanguage } from './ast-parser.js';
import type { AstLanguage, AstNode, AstParser } from './ast-parser.js';

/** Depth-first search for any node of the given type anywhere in the tree. */
function findType(node: AstNode, type: string): boolean {
  if (node.type === type) return true;
  return node.children.some((child) => findType(child, type));
}

describe('capture/ast-parser — Phase 4.2', () => {
  let parser: AstParser | undefined;

  afterEach(async () => {
    if (parser) {
      await parser.close();
      parser = undefined;
    }
  });

  // ── detectLanguage ─────────────────────────────────────────────────────

  describe('detectLanguage', () => {
    const cases: Array<[string, AstLanguage]> = [
      ['src/index.js', 'javascript'],
      ['src/Component.jsx', 'javascript'],
      ['src/module.mjs', 'javascript'],
      ['src/module.cjs', 'javascript'],
      ['src/index.ts', 'typescript'],
      ['src/module.mts', 'typescript'],
      ['src/module.cts', 'typescript'],
      ['src/Component.tsx', 'tsx'],
    ];

    for (const [path, expected] of cases) {
      it(`maps ${path} to ${expected}`, () => {
        expect(detectLanguage(path)).toBe(expected);
      });
    }

    it('returns null for unrecognized extensions', () => {
      expect(detectLanguage('README.md')).toBeNull();
      expect(detectLanguage('data.json')).toBeNull();
      expect(detectLanguage('no-extension')).toBeNull();
    });
  });

  // ── Parse correctness ──────────────────────────────────────────────────

  it('parses a JS fixture into a program tree containing a lexical_declaration', async () => {
    parser = createAstParser();
    const root = await parser.parse('const x = 1;', 'javascript');
    expect(root.type).toBe('program');
    expect(findType(root, 'lexical_declaration')).toBe(true);
  });

  it('parses a TS fixture and produces a type_annotation node (proves the TS grammar, not JS, is in use)', async () => {
    parser = createAstParser();
    const root = await parser.parse('const x: number = 1;', 'typescript');
    expect(root.type).toBe('program');
    expect(findType(root, 'type_annotation')).toBe(true);
  });

  it('parses a TSX fixture and produces a JSX element node (proves the bundled tsx grammar loads)', async () => {
    parser = createAstParser();
    const root = await parser.parse('const el = <div />;', 'tsx');
    expect(root.type).toBe('program');
    expect(findType(root, 'jsx_self_closing_element')).toBe(true);
  });

  it('rejects on an unrecognized language', async () => {
    parser = createAstParser();
    await expect(
      parser.parse('const x = 1;', 'unknown' as unknown as AstLanguage),
    ).rejects.toThrow();
  });

  it('close() terminates the worker cleanly', async () => {
    parser = createAstParser();
    await parser.parse('const x = 1;', 'javascript');
    await parser.close();
    parser = undefined; // already closed; afterEach should no-op
  });

  // ── Basic memory-leak check ────────────────────────────────────────────

  it(
    'does not show unbounded heap growth across repeated parse cycles',
    async () => {
      parser = createAstParser();
      const fixture = 'function add(a, b) { return a + b; } const result = add(1, 2);';

      // Warm up first, so JIT/allocator one-time costs don't skew the baseline.
      for (let i = 0; i < 50; i++) {
        await parser.parse(fixture, 'javascript');
      }
      const baseline = await parser.debugHeapUsed();

      for (let i = 0; i < 300; i++) {
        await parser.parse(fixture, 'javascript');
      }
      const afterMany = await parser.debugHeapUsed();

      // A missing tree.delete()/parser.delete() would leak roughly
      // proportionally to iteration count. This bound is generous (allows
      // for GC/allocator noise) while still catching an actual leak: 300
      // un-freed trees/parsers for a fixture this size would blow well past it.
      const growth = afterMany - baseline;
      expect(growth).toBeLessThan(baseline * 2 + 10 * 1024 * 1024);
    },
    20000,
  );
});
