import { resolve } from 'node:path';
import { openDatabase } from '../storage/index.js';
import { stenoDir } from '../workspace/sandbox.js';
import { compileManifest } from '../compiler/index.js';
import { calculateRecall } from './recall-calculator.js';
import type { GraphNodeForRecall } from './recall-calculator.js';
import { extractIdentifiers } from './identifier-extraction.js';
import { createAstParser, detectLanguage } from '../capture/ast-parser.js';
import type { AstParser } from '../capture/ast-parser.js';

/**
 * Phase 11.3 addition: recomputes found/total counts to display alongside
 * each percentage (e.g. "Functions: 100.0% (0/0)"), so a vacuous 100% from
 * an empty category (Phase 11.2's `computeFraction()` treats "nothing to
 * recall" as trivially perfect) is visually distinguishable from a genuine
 * 100%. Deliberately reruns the same extraction Phase 11.2's
 * `calculateRecall()` does internally, rather than exposing counts on
 * `RecallResult` — `recall-calculator.ts` is Phase 11.2's own file, already
 * `Verified`, and per explicit decision this stays a display-only addition
 * scoped to Phase 11.3's file, not a change to Phase 11.2's tested formula.
 */
async function countIdentifierMatches(
  sourceNodes: GraphNodeForRecall[],
  manifestText: string,
  parser: AstParser
): Promise<{
  functionsFound: number;
  functionsTotal: number;
  variablesFound: number;
  variablesTotal: number;
  errorCodesFound: number;
  errorCodesTotal: number;
}> {
  const sourceFunctions = new Set<string>();
  const sourceVariables = new Set<string>();
  const sourceErrorCodes = new Set<string>();

  for (const node of sourceNodes) {
    const lang = node.source_file ? detectLanguage(node.source_file) : null;
    const extracted = await extractIdentifiers(node.content, parser, lang);
    extracted.functions.forEach((f) => sourceFunctions.add(f));
    extracted.variables.forEach((v) => sourceVariables.add(v));
    extracted.errorCodes.forEach((e) => sourceErrorCodes.add(e));
  }

  const manifestExtracted = await extractIdentifiers(manifestText, parser, null);
  const allManifestIdentifiers = new Set([
    ...manifestExtracted.functions,
    ...manifestExtracted.variables,
    ...manifestExtracted.errorCodes,
  ]);
  const countFound = (s: Set<string>): number =>
    Array.from(s).filter((item) => allManifestIdentifiers.has(item)).length;

  return {
    functionsFound: countFound(sourceFunctions),
    functionsTotal: sourceFunctions.size,
    variablesFound: countFound(sourceVariables),
    variablesTotal: sourceVariables.size,
    errorCodesFound: countFound(sourceErrorCodes),
    errorCodesTotal: sourceErrorCodes.size,
  };
}

async function runEval() {
  const projectRoot = process.argv[2];
  if (!projectRoot) {
    console.error('Usage: npm run evaluate <project-root>');
    process.exit(1);
  }

  const resolvedRoot = resolve(projectRoot);
  const dbPath = resolve(stenoDir(resolvedRoot), 'graph.db');
  console.log(`Evaluating against DB: ${dbPath}`);

  // Open DB (runs migrations if needed)
  const db = openDatabase(dbPath);

  // 1. Fetch active graph nodes directly
  const rows = db.prepare(`SELECT content, source_file FROM graph_nodes WHERE status = 'ACTIVE'`).all() as GraphNodeForRecall[];
  if (rows.length === 0) {
    console.log('No ACTIVE nodes found in DB. Recall: N/A');
    process.exit(0);
  }
  console.log(`Fetched ${rows.length} ACTIVE nodes from DB.`);

  // 2. Compile manifest using the orchestrator
  // 64k token budget is a generous default for eval purposes
  const manifest = compileManifest(db, 64000, {
    resumeInstruction: 'Resume this coding session using the causal history above.',
    fsmState: 'IDE_IDLE'
  });
  
  const manifestText = JSON.stringify(manifest);

  // 3. Compute recall
  const parser = createAstParser();
  try {
    const recall = await calculateRecall(rows, manifestText, parser);
    const counts = await countIdentifierMatches(rows, manifestText, parser);
    const overallFound = counts.functionsFound + counts.variablesFound + counts.errorCodesFound;
    const overallTotal = counts.functionsTotal + counts.variablesTotal + counts.errorCodesTotal;

    console.log('--- Exact-Identifier Recall ---');
    console.log(
      `Functions:   ${(recall.functionsRecall * 100).toFixed(1)}% (${counts.functionsFound}/${counts.functionsTotal})`
    );
    console.log(
      `Variables:   ${(recall.variablesRecall * 100).toFixed(1)}% (${counts.variablesFound}/${counts.variablesTotal})`
    );
    console.log(
      `Error Codes: ${(recall.errorCodesRecall * 100).toFixed(1)}% (${counts.errorCodesFound}/${counts.errorCodesTotal})`
    );
    console.log(
      `OVERALL:     ${(recall.overallRecall * 100).toFixed(1)}% (${overallFound}/${overallTotal})`
    );
  } finally {
    await parser.close();
    db.close();
  }
}

runEval().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
