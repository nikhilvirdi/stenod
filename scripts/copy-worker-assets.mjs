// Copies plain-JS worker-thread entry points from src/ into dist/ after
// `tsc` runs, since tsc does not emit non-.ts source files on its own.
// Currently only src/capture/ast-parser.worker.js (Phase 4.2) needs this.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const workerAssets = ['capture/ast-parser.worker.js'];

for (const relPath of workerAssets) {
  const from = join(repoRoot, 'src', relPath);
  const to = join(repoRoot, 'dist', relPath);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
