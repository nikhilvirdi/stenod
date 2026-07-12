import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Socket } from 'node:net';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { IngestionQueue } from '../capture/queue.js';
import { createTerminalBridgeHandler } from './terminal-bridge.js';

/**
 * Phase 7.5 — Terminal Bridge (Daemon-Side Handler) Tests
 *
 * Unit-level coverage of `createTerminalBridgeHandler()` in isolation —
 * the full end-to-end path (real client, real PTY, real IPC round-trip) is
 * covered by `cli/attach.test.ts` and `daemon/lifecycle.test.ts`'s Phase
 * 7.5 integration tests.
 *
 * Coverage:
 *   1. a well-formed terminal-result message writes a TERMINAL_SUCCESS node
 *      (exit code 0) via the same writeTerminalNode() createTerminalCapture()
 *      itself calls, and acks the socket
 *   2. a non-zero exit code writes TERMINAL_ERROR and fires the FSM's ERROR
 *      event (matching writeTerminalNode()'s own documented behavior)
 *   3. a malformed/wrong-shaped message is ignored — no write, no ack, no throw
 *   4. when a queue is supplied, the write is routed through it (matching
 *      every other capture track's Phase 7.2 wiring)
 */
describe('daemon/terminal-bridge — Phase 7.5', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function migratedDb(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-terminal-bridge-test-'));
    db = openDatabase(join(tempDir, 'graph.db'));
    runMigrations(db);
    return db;
  }

  afterEach(() => {
    if (db) {
      db.close();
      db = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function fakeSocket(): { socket: Socket; writes: string[] } {
    const writes: string[] = [];
    const socket = {
      write: (data: string) => {
        writes.push(data);
        return true;
      },
    } as unknown as Socket;
    return { socket, writes };
  }

  function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (predicate()) {
          clearInterval(interval);
          resolve(true);
        } else if (Date.now() - start >= timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      }, 10);
    });
  }

  it('a well-formed terminal-result message (exit 0) writes a TERMINAL_SUCCESS node and acks', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm();
    const handler = createTerminalBridgeHandler(conn, fsm);
    const { socket, writes } = fakeSocket();

    handler({ type: 'terminal-result', content: 'npm test passed', exitCode: 0 }, socket);

    const row = conn.prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_SUCCESS'").get() as
      | { content: string; fsm_state: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.content).toBe('npm test passed');

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toEqual({ type: 'terminal-result-ack', written: true });
  });

  it('a non-zero exit code writes TERMINAL_ERROR and fires the FSM ERROR event', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm();
    expect(fsm.state).toBe('IDE_IDLE');
    const handler = createTerminalBridgeHandler(conn, fsm);
    const { socket } = fakeSocket();

    handler({ type: 'terminal-result', content: 'Error: build failed', exitCode: 1 }, socket);

    const row = conn.prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_ERROR'").get() as
      | { fsm_state: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.fsm_state).toBe('RUNTIME_ERR');
    expect(fsm.state).toBe('RUNTIME_ERR');
  });

  it('a malformed/wrong-shaped message is ignored — no write, no ack, no throw', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm();
    const handler = createTerminalBridgeHandler(conn, fsm);
    const { socket, writes } = fakeSocket();

    expect(() => handler({ type: 'not-a-terminal-result' }, socket)).not.toThrow();
    expect(() => handler('just a string', socket)).not.toThrow();
    expect(() => handler(null, socket)).not.toThrow();
    expect(() => handler({ type: 'terminal-result', content: 'x' }, socket)).not.toThrow(); // missing exitCode

    const count = (conn.prepare('SELECT COUNT(*) AS c FROM graph_nodes').get() as { c: number }).c;
    expect(count).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('with a queue supplied, the write is routed through it and settles asynchronously', async () => {
    const conn = migratedDb();
    const fsm = new SessionFsm();
    const queue = new IngestionQueue();
    const handler = createTerminalBridgeHandler(conn, fsm, queue);
    const { socket, writes } = fakeSocket();

    handler({ type: 'terminal-result', content: 'queued write', exitCode: 0 }, socket);

    const found = await waitFor(() => {
      const row = conn.prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_SUCCESS'").get();
      return row !== undefined;
    }, 3000);
    expect(found).toBe(true);

    const acked = await waitFor(() => writes.length > 0, 3000);
    expect(acked).toBe(true);
    expect(JSON.parse(writes[0]!)).toEqual({ type: 'terminal-result-ack', written: true });
    expect(queue.depth).toBe(0);
  });
});
