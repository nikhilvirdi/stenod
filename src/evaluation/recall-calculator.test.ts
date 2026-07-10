import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { calculateRecall } from './recall-calculator.js';
import { createAstParser } from '../capture/ast-parser.js';
import type { AstParser } from '../capture/ast-parser.js';

describe('evaluation/recall-calculator — Phase 11.2', () => {
  let parser: AstParser;

  beforeAll(async () => {
    parser = createAstParser();
    await parser.debugHeapUsed();
  });

  afterAll(async () => {
    if (parser) {
      await parser.close();
    }
  });

  it('computes correct exact-identifier recall fraction on a hand-computed fixture', async () => {
    // 1. Hand-crafted source node content
    const sourceContent = `
      function myFunc(myVar) {
        myVar.myProp = 1;
        const E_MY_ERROR = 2;
      }
    `;
    
    // Expected extraction from sourceContent (via Phase 11.1's utility):
    // - Functions: 'myFunc' (1)
    // - Error Codes: 'E_MY_ERROR' (1)
    // - Variables: 'myVar', 'myProp' (2)  <- Note: E_MY_ERROR is scrubbed from variables by Phase 11.1
    // Total source identifiers: 4

    // 2. Hand-crafted compiled manifest content
    const manifestContent = `
      The manifest mentions myFunc and E_MY_ERROR but forgets the variables.
    `;

    // Expected recall matching:
    // - Functions: 'myFunc' is in the manifest (1/1 = 100%)
    // - Error Codes: 'E_MY_ERROR' is in the manifest (1/1 = 100%)
    // - Variables: 'myVar' and 'myProp' are NOT in the manifest (0/2 = 0%)
    // - Overall: 2 out of 4 source identifiers found (2/4 = 50%)

    const result = await calculateRecall(
      [{ content: sourceContent, source_file: 'src/test.js' }],
      manifestContent,
      parser
    );

    expect(result.functionsRecall).toBe(1.0);     // 1/1
    expect(result.errorCodesRecall).toBe(1.0);    // 1/1
    expect(result.variablesRecall).toBe(0.0);     // 0/2
    expect(result.overallRecall).toBe(0.5);       // 2/4
  });
});
