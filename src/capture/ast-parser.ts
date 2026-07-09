/**
 * Phase 4.2 — web-tree-sitter Integration
 *
 * SSOT §6.2: on save, content is parsed by web-tree-sitter in a background
 * thread (explicit tree.delete()/parser.delete() prevents memory leaks).
 *
 * This module is a standalone, callable AST parser — it does not subscribe
 * to the Phase 4.1 watcher's onChange callback. Wiring filesystem save
 * events to this parser (and the resulting content into graph_nodes) is
 * Phase 4.4's job, mirroring the same boundary Phase 4.1 drew for itself.
 *
 * The actual WASM parsing happens in ast-parser.worker.js, a plain-JS
 * worker_threads entry point (see that file for why it isn't TypeScript).
 * This module only resolves grammar wasm paths, spawns that worker, and
 * exposes a small request/response API over it.
 */

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { extname } from 'node:path';

// ── Public types ─────────────────────────────────────────────────────────────

/** Languages this phase loads grammars for (SSOT §6.2: "JavaScript/TypeScript at launch"). */
export type AstLanguage = 'javascript' | 'typescript' | 'tsx';

/** A plain-object, structured-clone-safe mirror of a web-tree-sitter Node. */
export interface AstNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  children: AstNode[];
}

export interface AstParser {
  /** Parses `content` as `language` in the background worker thread. */
  parse(content: string, language: AstLanguage): Promise<AstNode>;
  /**
   * Diagnostic-only: returns the worker thread's own current
   * `process.memoryUsage().heapUsed`. Exists so tests can observe the
   * background thread's heap directly (there is no public Node API to
   * inspect another thread's heap from outside it) — not intended for
   * production use.
   */
  debugHeapUsed(): Promise<number>;
  /** Terminates the background worker. Safe to call once parsing is done. */
  close(): Promise<void>;
}

// ── Extension → language detection ──────────────────────────────────────────

const EXTENSION_LANGUAGE: Readonly<Record<string, AstLanguage>> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
};

/** Maps a file path's extension to the grammar that should parse it. */
export function detectLanguage(filePath: string): AstLanguage | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGE[ext] ?? null;
}

// ── Worker wiring ────────────────────────────────────────────────────────────

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; root: AstNode }
  | { type: 'error'; id: number; message: string }
  | { type: 'init-error'; message: string }
  | { type: 'memory-result'; id: number; heapUsed: number };

const requireFromHere = createRequire(import.meta.url);

/** Resolves each grammar's .wasm file from the locked npm packages. */
function resolveWasmPaths(): Record<AstLanguage, string> {
  return {
    javascript: requireFromHere.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm'),
    typescript: requireFromHere.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'),
    tsx: requireFromHere.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'),
  };
}

/**
 * Spawns the background parser worker and returns a small request/response
 * wrapper around it. One worker per AstParser instance; call close() when
 * done to free it.
 */
export function createAstParser(): AstParser {
  const worker = new Worker(new URL('./ast-parser.worker.js', import.meta.url), {
    workerData: { wasmPaths: resolveWasmPaths() },
  });

  let nextId = 0;
  const pendingParse = new Map<
    number,
    { resolve: (node: AstNode) => void; reject: (err: Error) => void }
  >();
  const pendingMemory = new Map<number, (heapUsed: number) => void>();

  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  worker.on('message', (msg: WorkerMessage) => {
    switch (msg.type) {
      case 'ready':
        readyResolve();
        return;
      case 'result': {
        const entry = pendingParse.get(msg.id);
        pendingParse.delete(msg.id);
        entry?.resolve(msg.root);
        return;
      }
      case 'error': {
        const entry = pendingParse.get(msg.id);
        pendingParse.delete(msg.id);
        entry?.reject(new Error(msg.message));
        return;
      }
      case 'init-error':
        readyReject(new Error(msg.message));
        return;
      case 'memory-result': {
        const resolve = pendingMemory.get(msg.id);
        pendingMemory.delete(msg.id);
        resolve?.(msg.heapUsed);
        return;
      }
    }
  });

  worker.on('error', (err: Error) => {
    readyReject(err);
    for (const entry of pendingParse.values()) entry.reject(err);
    pendingParse.clear();
  });

  return {
    async parse(content: string, language: AstLanguage): Promise<AstNode> {
      await ready;
      const id = nextId++;
      return new Promise<AstNode>((resolve, reject) => {
        pendingParse.set(id, { resolve, reject });
        worker.postMessage({ type: 'parse', id, content, language });
      });
    },

    async debugHeapUsed(): Promise<number> {
      await ready;
      const id = nextId++;
      return new Promise<number>((resolve) => {
        pendingMemory.set(id, resolve);
        worker.postMessage({ type: 'memory', id });
      });
    },

    async close(): Promise<void> {
      await worker.terminate();
    },
  };
}
