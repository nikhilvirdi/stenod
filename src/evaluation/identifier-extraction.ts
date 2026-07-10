import type { AstNode, AstParser, AstLanguage } from '../capture/ast-parser.js';

export interface ExtractedIdentifiers {
  functions: string[];
  variables: string[];
  errorCodes: string[];
}

const ERROR_CODE_REGEX = /\b[A-Z][A-Z0-9_]+\b/g;
const FALLBACK_IDENTIFIER_REGEX = /\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g;

// Standard reserved words to ignore in regex fallback mode
const RESERVED_WORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'function', 'class', 'extends', 'implements', 'interface', 'type', 'const',
  'let', 'var', 'import', 'export', 'from', 'as', 'try', 'catch', 'finally', 'throw',
  'new', 'this', 'super', 'typeof', 'instanceof', 'void', 'delete', 'yield', 'await',
  'async', 'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'String', 'Number',
  'Boolean', 'Object', 'Array', 'Promise', 'Error'
]);

/**
 * Traverses a tree-sitter AST to extract function and variable usage identifiers.
 */
function traverseAst(node: AstNode, functions: Set<string>, variables: Set<string>) {
  // Tree-sitter JS/TS parses function calls as `call_expression` with the first
  // child typically being the function identifier or member expression.
  if (node.type === 'call_expression') {
    const funcNode = node.children[0];
    if (funcNode) {
      if (funcNode.type === 'identifier') {
        functions.add(funcNode.text);
      } else if (funcNode.type === 'member_expression') {
        const prop = funcNode.children.find((c) => c.type === 'property_identifier');
        if (prop) {
          functions.add(prop.text);
        }
      }
    }
  } else if (node.type === 'function_declaration' || node.type === 'method_definition') {
    const idNode = node.children.find(
      (c) => c.type === 'identifier' || c.type === 'property_identifier'
    );
    if (idNode) {
      functions.add(idNode.text);
    }
  } else if (node.type === 'identifier' || node.type === 'property_identifier' || node.type === 'shorthand_property_identifier') {
    // If we haven't already classified it as a function in a parent traversal,
    // bucket it into variables. In a real graph, a name might be both (e.g. `const f = () => {}`),
    // but the goal is just to capture the usage.
    variables.add(node.text);
  }

  for (const child of node.children) {
    traverseAst(child, functions, variables);
  }
}

/**
 * Fallback regex extractor for non-AST content (like TERMINAL_ERROR nodes).
 */
function extractRegexFallback(content: string, variables: Set<string>, errorCodes: Set<string>) {
  const matches = content.matchAll(FALLBACK_IDENTIFIER_REGEX);
  for (const match of matches) {
    const text = match[0];
    if (errorCodes.has(text)) continue;
    if (!RESERVED_WORDS.has(text)) {
      variables.add(text);
    }
  }
}

/**
 * Phase 11.1 — Identifier Extraction Utility
 *
 * Extracts function names, variable names, and error codes from node content.
 * Reuses the Phase 4.2 AST parser if provided, falling back to regex for
 * non-code nodes (e.g. terminal output) per SSOT §12.
 */
export async function extractIdentifiers(
  content: string,
  parser?: AstParser,
  language?: AstLanguage | null
): Promise<ExtractedIdentifiers> {
  const functions = new Set<string>();
  const variables = new Set<string>();
  const errorCodes = new Set<string>();

  // Error codes are always extracted via regex as requested (no AST .code matching)
  const errMatches = content.matchAll(ERROR_CODE_REGEX);
  for (const match of errMatches) {
    errorCodes.add(match[0]);
  }

  if (parser && language) {
    try {
      const rootNode = await parser.parse(content, language);
      traverseAst(rootNode, functions, variables);
      
      // Cleanup: remove anything from variables that was definitively categorized as a function
      for (const fn of functions) {
        variables.delete(fn);
      }
    } catch {
      // Fallback on parse failure
      extractRegexFallback(content, variables, errorCodes);
    }
  } else {
    // Non-AST fallback (terminal output, unparseable logs)
    extractRegexFallback(content, variables, errorCodes);
  }

  // Cleanup: error codes shouldn't double-count as variables
  for (const code of errorCodes) {
    variables.delete(code);
    functions.delete(code);
  }

  return {
    functions: Array.from(functions).sort(),
    variables: Array.from(variables).sort(),
    errorCodes: Array.from(errorCodes).sort(),
  };
}
