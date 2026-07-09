// Phase 4.2 — web-tree-sitter Integration
//
// Worker-thread entry point. Runs the actual WASM parsing off the main
// thread, per SSOT §6.1 ("parsed by web-tree-sitter in a background
// thread"). Deliberately plain ESM JavaScript, not TypeScript: a Worker
// loads its entry file through Node's own module loader, independent of
// whatever transform pipeline (vitest, tsc) the rest of the project uses.
// Plain .js needs no transform in any of those contexts.
//
// Protocol (all messages are plain objects over parentPort):
//   -> { type: 'parse', id, content, language }
//   <- { type: 'result', id, root: AstNode }
//   <- { type: 'error', id, message }
//   -> { type: 'memory', id }
//   <- { type: 'memory-result', id, heapUsed }
//   <- { type: 'ready' }   (sent once, after all grammars are loaded)

import { parentPort, workerData } from 'node:worker_threads';
import { Parser, Language } from 'web-tree-sitter';

if (!parentPort) {
  throw new Error('ast-parser.worker.js must be run as a worker_threads Worker');
}

/** @type {Map<string, import('web-tree-sitter').Language>} */
const languages = new Map();

/**
 * Recursively convert a live web-tree-sitter Node into a plain, structured-
 * clone-safe object so it can cross the worker boundary via postMessage.
 * @param {import('web-tree-sitter').Node} node
 */
function serializeNode(node) {
  const children = node.children
    .filter((child) => child !== null)
    .map((child) => serializeNode(child));

  return {
    type: node.type,
    text: node.text,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    children,
  };
}

async function init() {
  await Parser.init();

  const { wasmPaths } = workerData;
  for (const [language, wasmPath] of Object.entries(wasmPaths)) {
    languages.set(language, await Language.load(wasmPath));
  }

  parentPort.postMessage({ type: 'ready' });
}

parentPort.on('message', (msg) => {
  if (msg.type === 'memory') {
    parentPort.postMessage({
      type: 'memory-result',
      id: msg.id,
      heapUsed: process.memoryUsage().heapUsed,
    });
    return;
  }

  if (msg.type === 'parse') {
    const { id, content, language } = msg;
    const grammar = languages.get(language);

    if (!grammar) {
      parentPort.postMessage({
        type: 'error',
        id,
        message: `Unknown or unloaded grammar: ${language}`,
      });
      return;
    }

    const parser = new Parser();
    let tree;
    try {
      parser.setLanguage(grammar);
      tree = parser.parse(content);
      if (!tree) {
        parentPort.postMessage({ type: 'error', id, message: 'Parse returned no tree' });
        return;
      }
      parentPort.postMessage({ type: 'result', id, root: serializeNode(tree.rootNode) });
    } catch (err) {
      parentPort.postMessage({
        type: 'error',
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      tree?.delete();
      parser.delete();
    }
  }
});

init().catch((err) => {
  parentPort.postMessage({
    type: 'init-error',
    message: err instanceof Error ? err.message : String(err),
  });
});
