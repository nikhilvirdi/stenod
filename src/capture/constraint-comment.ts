/**
 * Phase 4.3 — Constraint Comment Syntax Parser
 *
 * SSOT §6.2: "// VCS: constraint[key]=value" (or the equivalent per-language
 * comment syntax), recognized wherever tree-sitter identifies a comment
 * node — language-agnostic since it matches comment text, not code
 * structure.
 *
 * Operates on the AstNode tree produced by Phase 4.2's parser
 * (capture/ast-parser.ts). Does not parse source text itself, and does not
 * create graph_nodes rows or apply LWW conflict resolution — associating
 * extracted constraints with CONSTRAINT nodes is a later phase's job.
 */

import type { AstNode } from './ast-parser.js';

export interface ConstraintComment {
  key: string;
  value: string;
  /** Byte offsets of the comment node within the parsed source. */
  startIndex: number;
  endIndex: number;
}

// Matches exactly `// VCS: constraint[key]=value`, tolerant of extra
// whitespace around the `VCS:` marker and inside the brackets. JS/TS's line
// comment token is `//` — the only comment syntax this phase's grammars
// (tree-sitter-javascript/typescript) produce for this form, per SSOT §6.2's
// "// ... (or the equivalent per-language comment syntax)" note.
const CONSTRAINT_COMMENT_PATTERN = /^\/\/\s*VCS:\s*constraint\[([^\]]*)\]=(.*)$/;

/**
 * Walks the AST for `comment` nodes and extracts any that match the
 * constraint syntax. Ordinary comments — including ones that merely mention
 * "VCS" or "constraint" without matching the exact pattern — are ignored.
 */
export function extractConstraintComments(root: AstNode): ConstraintComment[] {
  const results: ConstraintComment[] = [];
  walk(root, results);
  return results;
}

function walk(node: AstNode, results: ConstraintComment[]): void {
  if (node.type === 'comment') {
    const match = CONSTRAINT_COMMENT_PATTERN.exec(node.text);
    if (match) {
      results.push({
        key: match[1].trim(),
        value: match[2].trim(),
        startIndex: node.startIndex,
        endIndex: node.endIndex,
      });
    }
    return; // comment nodes are leaf tokens — nothing further to descend into
  }

  for (const child of node.children) {
    walk(child, results);
  }
}
