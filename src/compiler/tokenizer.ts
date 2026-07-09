import { encode } from 'gpt-tokenizer';

/**
 * Phase 8.1 — Token Counting
 *
 * SSOT §6.4: "Token counting: a local, offline tokenizer library (e.g. gpt-tokenizer)
 * measures token_cost per node — zero network calls, consistent with the offline guarantee."
 *
 * This measures the token_cost for the greedy-by-ratio knapsack packing (Phase 8.4).
 */
export function countTokens(text: string): number {
  return encode(text).length;
}
