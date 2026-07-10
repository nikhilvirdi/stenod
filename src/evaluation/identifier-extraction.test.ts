import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAstParser } from '../capture/ast-parser.js';
import type { AstParser } from '../capture/ast-parser.js';
import { extractIdentifiers } from './identifier-extraction.js';

/**
 * Phase 11.1 — Identifier Extraction Utility Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Correct identifier extraction on fixture source content
 *
 * Verifies AST extraction for variables and functions, regex fallback
 * for terminal/unparseable content, and error code regex extraction.
 */
describe('evaluation/identifier-extraction — Phase 11.1', () => {
  let parser: AstParser;

  beforeAll(async () => {
    parser = createAstParser();
    // Warm up the parser worker
    await parser.debugHeapUsed();
  });

  afterAll(async () => {
    if (parser) {
      await parser.close();
    }
  });

  it('extracts functions, variables, and error codes correctly from JS AST', async () => {
    const fixture = `
      const INITIAL_VALUE = 42;
      function computeTotal(items) {
        let sum = 0;
        for (const item of items) {
          sum += item.price;
        }
        if (sum < 0) {
          const err = new Error('Invalid sum');
          err.code = 'E_NEGATIVE_TOTAL';
          throw err;
        }
        return sum;
      }
      console.log(computeTotal([]));
    `;

    const result = await extractIdentifiers(fixture, parser, 'javascript');

    // Expected functions: computeTotal (declaration + call), log (member_expression call)
    // Expect error code: INITIAL_VALUE (all caps), E_NEGATIVE_TOTAL (all caps)
    // The rest should be variables.

    expect(result.functions).toContain('computeTotal');
    expect(result.functions).toContain('log');

    expect(result.errorCodes).toContain('E_NEGATIVE_TOTAL');
    expect(result.errorCodes).toContain('INITIAL_VALUE'); // Regex grabs this as an "error code" pattern, which is acceptable

    expect(result.variables).toContain('items');
    expect(result.variables).toContain('sum');
    expect(result.variables).toContain('item');
    expect(result.variables).toContain('price');
    expect(result.variables).toContain('console');
    expect(result.variables).toContain('err');
    
    // Ensure we don't have reserved words or error codes in variables
    expect(result.variables).not.toContain('const');
    expect(result.variables).not.toContain('function');
    expect(result.variables).not.toContain('E_NEGATIVE_TOTAL');
  });

  it('extracts correctly using the regex fallback for non-AST content (terminal)', async () => {
    const terminalFixture = `
      Error: Cannot find module 'worker_threads'
          at Module._resolveFilename (node:internal/modules/cjs/loader:1144:15)
          at process.exit (node:internal)
      {
        code: 'MODULE_NOT_FOUND',
        requireStack: [ '/stenod/src/cli/bin.js' ]
      }
    `;

    const result = await extractIdentifiers(terminalFixture); // No parser/language provided

    // Error codes via regex
    expect(result.errorCodes).toContain('MODULE_NOT_FOUND');

    // Variables via regex fallback
    expect(result.variables).toContain('Module');
    expect(result.variables).toContain('_resolveFilename');
    expect(result.variables).toContain('node');
    expect(result.variables).toContain('internal');
    expect(result.variables).toContain('modules');
    expect(result.variables).toContain('cjs');
    expect(result.variables).toContain('loader');
    expect(result.variables).toContain('process');
    expect(result.variables).toContain('exit');
    expect(result.variables).toContain('code');
    expect(result.variables).toContain('requireStack');
    expect(result.variables).toContain('stenod');
    expect(result.variables).toContain('src');
    expect(result.variables).toContain('cli');
    expect(result.variables).toContain('bin');
    expect(result.variables).toContain('js');

    // Reserved words should be excluded
    expect(result.variables).not.toContain('Error'); // In our RESERVED_WORDS
  });

  it('AST traversal captures property identifiers correctly', async () => {
    const fixture = `
      const obj = {
        myProp: 123,
        myMethod() { return this.myProp; }
      };
      obj.myProp;
      obj.myMethod();
    `;

    const result = await extractIdentifiers(fixture, parser, 'javascript');

    expect(result.functions).toContain('myMethod');
    expect(result.variables).toContain('obj');
    expect(result.variables).toContain('myProp');
  });
});
