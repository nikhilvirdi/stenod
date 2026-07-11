import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stenoDir } from '../workspace/sandbox.js';
import { openDatabase, runMigrations } from '../storage/index.js';
import { compileManifest } from '../compiler/index.js';
import { writeManifestLogEntry } from '../delivery/manifest-log.js';
import { deriveCurrentFsmState, deriveUnresolvedErrorContext } from '../cli/handoff-context.js';

// Constants matching the CLI defaults, since they are not exported from program.ts
const DEFAULT_TOKEN_BUDGET = 8000;
const RESUME_INSTRUCTION = 'Resume this coding session using the causal history above.';

/**
 * Phase 13.1 — MCP Resource Exposure of Handoff
 *
 * Runs an MCP server over stdio, exposing the handoff manifest as an MCP resource.
 * This does not replace clipboard delivery (`stenod handoff`), which remains the
 * primary delivery mechanism when MCP is unavailable.
 */
export async function runMcpServer(root: string = process.cwd()): Promise<void> {
  const server = new McpServer({
    name: 'stenod',
    version: '1.0.0',
  });

  server.resource(
    'handoff',
    'stenod://handoff/manifest',
    async (uri) => {
      if (!existsSync(stenoDir(root))) {
        throw new Error(`stenod: no Stenod workspace found at ${root} — run \`stenod init\` first.`);
      }

      const db = openDatabase(join(stenoDir(root), 'graph.db'));
      try {
        runMigrations(db);

        const fsmState = deriveCurrentFsmState(db);
        const unresolvedErrorContext =
          fsmState === 'RUNTIME_ERR' ? deriveUnresolvedErrorContext(db) : undefined;

        const manifest = compileManifest(db, DEFAULT_TOKEN_BUDGET, {
          resumeInstruction: RESUME_INSTRUCTION,
          fsmState,
          unresolvedErrorContext,
        });

        // The SSOT requires that every compiled manifest is logged (manifest_log)
        // before delivery, identically to the clipboard path.
        writeManifestLogEntry(db, manifest);

        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(manifest),
              mimeType: 'application/json',
            },
          ],
        };
      } finally {
        db.close();
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
