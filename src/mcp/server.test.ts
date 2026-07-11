import { describe, it, expect, afterEach, vi, type MockInstance } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, runMigrations } from '../storage/index.js';
import { stenoDir } from '../workspace/sandbox.js';
import { runMcpServer } from './server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  return {
    McpServer: vi.fn().mockImplementation(function () {
      return {
        resource: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  return {
    StdioServerTransport: vi.fn(),
  };
});

describe('mcp/server — Phase 13.1', () => {
  const tempDirs: string[] = [];

  function makeInitializedRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-mcp-server-test-'));
    tempDirs.push(dir);
    mkdirSync(stenoDir(dir), { recursive: true });
    const db = openDatabase(join(stenoDir(dir), 'graph.db'));
    runMigrations(db);
    db.close();
    return dir;
  }

  function insertNode(
    root: string,
    id: string,
    eventId: number,
    type: string,
    content: string,
    fsmState = 'IDE_IDLE',
    createdAt: number = Date.now()
  ): void {
    const db = openDatabase(join(stenoDir(root), 'graph.db'));
    db.prepare(
      `INSERT INTO graph_nodes
         (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'ACTIVE', NULL, ?)`
    ).run(id, eventId, type, content, fsmState, createdAt);
    db.close();
  }

  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs.length = 0;
  });

  it('registers the handoff resource and connects to stdio transport', async () => {
    const root = makeInitializedRoot();
    await runMcpServer(root);

    expect(McpServer).toHaveBeenCalledWith({
      name: 'stenod',
      version: '1.0.0',
    });

    const mcpServerMock = McpServer as unknown as MockInstance;
    const mockServerInstance = mcpServerMock.mock.results[0]?.value as {
      resource: MockInstance;
      connect: MockInstance;
    };

    expect(mockServerInstance.resource).toHaveBeenCalledWith(
      'handoff',
      'stenod://handoff/manifest',
      expect.any(Function)
    );
    expect(StdioServerTransport).toHaveBeenCalled();
    expect(mockServerInstance.connect).toHaveBeenCalled();
  });

  it('reads the manifest correctly when the resource is requested', async () => {
    const root = makeInitializedRoot();
    // CONSTRAINT type deliberately, not FILE_STATE: per SSOT §6.4's Phase
    // 8.10 tiered content inclusion rule, CONSTRAINT nodes always carry
    // full, uncapped content regardless of utility score, so this is the
    // one tier that lets a single, edge-free, freshly-created fixture node
    // prove real content survives the whole pipeline deterministically — a
    // FILE_STATE node with no causal edges scores well under the 0.6
    // tier-2 threshold and would only ever produce the tier-3 template.
    insertNode(root, 'node-1', 1, 'CONSTRAINT', 'This is a test node');

    await runMcpServer(root);
    
    const mcpServerMock = McpServer as unknown as MockInstance;
    const mockServerInstance = mcpServerMock.mock.results[0]?.value as {
      resource: MockInstance;
    };
    
    const resourceHandler = mockServerInstance.resource.mock.calls[0]?.[2] as (
      uri: URL
    ) => Promise<{ contents: Array<{ uri: string; text: string; mimeType: string }> }>;

    const result = await resourceHandler(new URL('stenod://handoff/manifest'));

    expect(result).toBeDefined();
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe('stenod://handoff/manifest');
    expect(result.contents[0].mimeType).toBe('application/json');
    
    // Phase 8.10 fixed the prior gap where PackableNode carried only
    // metadata: a CONSTRAINT node's real content now genuinely reaches the
    // MCP resource payload (full, uncapped, per SSOT §6.4's tier 1), not
    // just its id.
    expect(result.contents[0].text).toContain('"node-1"');
    expect(result.contents[0].text).toContain('This is a test node');

    // Verify it was logged in manifest_log
    const db = openDatabase(join(stenoDir(root), 'graph.db'));
    const rows = db.prepare('SELECT * FROM manifest_log').all();
    db.close();
    expect(rows).toHaveLength(1);
  });
});
