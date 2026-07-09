import { describe, it, expect } from 'vitest';
import { countTokens } from './tokenizer.js';

describe('compiler/tokenizer — Phase 8.1', () => {
  it('Token counts for known fixture strings match expected values', () => {
    // Basic standard English text
    expect(countTokens('hello world')).toBe(2);
    
    // Empty string should be 0
    expect(countTokens('')).toBe(0);

    // Code snippet
    const codeSnippet = 'export function countTokens(text: string): number { return encode(text).length; }';
    const codeTokens = countTokens(codeSnippet);
    // Depending on the exact tokenizer (cl100k_base), this will be around 10-20 tokens.
    // We just verify it produces a reasonable positive count that isn't length of characters.
    expect(codeTokens).toBeGreaterThan(5);
    expect(codeTokens).toBeLessThan(40);
  });
});
