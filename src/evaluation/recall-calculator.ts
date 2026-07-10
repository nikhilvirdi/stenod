import { extractIdentifiers } from './identifier-extraction.js';
import { detectLanguage } from '../capture/ast-parser.js';
import type { AstParser } from '../capture/ast-parser.js';

export interface GraphNodeForRecall {
  content: string;
  source_file: string | null;
}

export interface RecallResult {
  functionsRecall: number;
  variablesRecall: number;
  errorCodesRecall: number;
  overallRecall: number;
}

/**
 * Phase 11.2 — Exact-Identifier Recall Calculator
 *
 * Compares identifiers present in source graph nodes against those in a compiled
 * manifest, computing the fraction of source identifiers that survived into the manifest.
 */
export async function calculateRecall(
  sourceNodes: GraphNodeForRecall[],
  manifestText: string,
  parser: AstParser
): Promise<RecallResult> {
  const sourceFunctions = new Set<string>();
  const sourceVariables = new Set<string>();
  const sourceErrorCodes = new Set<string>();

  // 1. Extract from all source nodes using AST parsing where language is known
  for (const node of sourceNodes) {
    const lang = node.source_file ? detectLanguage(node.source_file) : null;
    const extracted = await extractIdentifiers(node.content, parser, lang);
    
    extracted.functions.forEach(f => sourceFunctions.add(f));
    extracted.variables.forEach(v => sourceVariables.add(v));
    extracted.errorCodes.forEach(e => sourceErrorCodes.add(e));
  }

  // 2. Extract from the compiled manifest text using the regex fallback
  // We pass language = null because the manifest is a mix of Markdown, JSON, and code,
  // so AST parsing would fail or produce garbage. The regex fallback accurately extracts tokens.
  const manifestExtracted = await extractIdentifiers(manifestText, parser, null);
  
  // Flatten all extracted manifest identifiers into a single set for membership testing.
  // Because the manifest is parsed via regex fallback, AST-specific bucketing (like functions)
  // won't happen here anyway — everything lands in variables or errorCodes.
  const allManifestIdentifiers = new Set([
    ...manifestExtracted.functions,
    ...manifestExtracted.variables,
    ...manifestExtracted.errorCodes
  ]);

  // 3. Compute recall fraction for each bucket
  const computeFraction = (sourceSet: Set<string>) => {
    if (sourceSet.size === 0) return 1.0; // If there was nothing to recall, recall is perfect
    let found = 0;
    for (const item of sourceSet) {
      if (allManifestIdentifiers.has(item)) found++;
    }
    return found / sourceSet.size;
  };

  const funcTotal = sourceFunctions.size;
  const varTotal = sourceVariables.size;
  const errTotal = sourceErrorCodes.size;
  const overallTotal = funcTotal + varTotal + errTotal;

  let overallFound = 0;
  sourceFunctions.forEach(f => allManifestIdentifiers.has(f) && overallFound++);
  sourceVariables.forEach(v => allManifestIdentifiers.has(v) && overallFound++);
  sourceErrorCodes.forEach(e => allManifestIdentifiers.has(e) && overallFound++);

  return {
    functionsRecall: computeFraction(sourceFunctions),
    variablesRecall: computeFraction(sourceVariables),
    errorCodesRecall: computeFraction(sourceErrorCodes),
    overallRecall: overallTotal > 0 ? overallFound / overallTotal : 1.0
  };
}
