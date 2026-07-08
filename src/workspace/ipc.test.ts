import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { createIpcServer, socketPath } from './ipc.js';
import { initToken } from './token.js';
import { stenoDir } from './sandbox.js';

/**
 * Phase 2.3 — IPC Scaffold + Token Enforcement Tests
 *
 * SSOT §6.1: every local socket/proxy connection requires a token.
 * SSOT §7: Unix Domain Socket (Linux/Mac), Named Pipe (Windows).
 *
 * Coverage:
 *   1.  socketPath returns a non-empty string
 *   2.  socketPath on Windows returns the named-pipe format
 *   3.  socketPath on Unix returns a path inside .stenod/ ending in .sock
 *   4.  two different project roots produce different socket paths
 *   5.  connection with correct token receives {ok:true}
 *   6.  connection with wrong token receives {ok:false}
 *   7.  connection with missing token field is rejected
 *   8.  connection with malformed JSON is rejected
 *   9.  token rotation: old token rejected on running server, new token accepted
 *  10.  two concurrent correct-token connections both succeed independently
 */

describe('IPC scaffold — Phase 2.3', () => {
  const tempDirs: string[] = [];
  // Servers started in a test. Closed in afterEach so a test failure never
  // leaves a listening server behind and blocks the next test.
  const servers: Array<ReturnType<typeof createIpcServer>> = [];

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-ipc-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    // Close all servers first, then delete temp dirs (the socket file lives
    // inside the temp dir on Unix — deletion order matters).
    await Promise.all(servers.map((s) => s.close()));
    servers.length = 0;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Connects to `path`, optionally sends `message` as a newline-terminated
   * JSON string, and resolves with the first parsed response object.
   *
   * If the connection is closed before a response arrives (e.g. server
   * destroys the socket without writing), resolves with `{ ok: false,
   * reason: 'connection-closed-without-response' }`.
   */
  function exchange(
    path: string,
    message: Record<string, unknown> | string | null,
  ): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve, reject) => {
      const client = createConnection(path);
      let responseBuffer = '';
      let resolved = false;

      function settle(result: { ok: boolean; reason?: string }): void {
        if (resolved) return;
        resolved = true;
        client.destroy();
        resolve(result);
      }

      client.once('connect', () => {
        if (message === null) return; // connect-only, send nothing

        let payload: string;
        if (typeof message === 'string') {
          // Raw string — used to send intentionally malformed data.
          payload = message + '\n';
        } else {
          payload = JSON.stringify(message) + '\n';
        }
        client.write(payload);
      });

      client.setEncoding('utf8');

      client.on('data', (chunk: string) => {
        responseBuffer += chunk;
        const idx = responseBuffer.indexOf('\n');
        if (idx !== -1) {
          const line = responseBuffer.slice(0, idx).trim();
          try {
            settle(JSON.parse(line) as { ok: boolean; reason?: string });
          } catch {
            settle({ ok: false, reason: 'unparseable-response' });
          }
        }
      });

      client.on('close', () => {
        settle({ ok: false, reason: 'connection-closed-without-response' });
      });

      client.on('error', (err) => {
        if (!resolved) reject(err);
      });
    });
  }

  // ── socketPath helpers ───────────────────────────────────────────────────────

  it('socketPath returns a non-empty string', () => {
    const root = makeTempRoot();
    const sp = socketPath(root);
    expect(typeof sp).toBe('string');
    expect(sp.length).toBeGreaterThan(0);
  });

  it('socketPath on Windows returns a named-pipe path', () => {
    if (process.platform !== 'win32') return;
    const root = makeTempRoot();
    // Must start with the Windows named pipe prefix.
    expect(socketPath(root)).toMatch(/^\\\\.\\pipe\\stenod-[0-9a-f]{16}$/);
  });

  it('socketPath on Unix returns a .sock file inside .stenod/', () => {
    if (process.platform === 'win32') return;
    const root = makeTempRoot();
    const sp = socketPath(root);
    expect(sp).toContain(stenoDir(root));
    expect(sp).toMatch(/daemon\.sock$/);
  });

  it('two different project roots produce different socket paths', () => {
    const rootA = makeTempRoot();
    const rootB = makeTempRoot();
    expect(socketPath(rootA)).not.toBe(socketPath(rootB));
  });

  // ── Auth enforcement ─────────────────────────────────────────────────────────

  it('connection with correct token receives {ok:true}', async () => {
    const root = makeTempRoot();
    const token = initToken(root);
    const srv = createIpcServer(root);
    servers.push(srv);
    await srv.listen();

    const result = await exchange(srv.path, { token });
    expect(result.ok).toBe(true);
  });

  it('connection with wrong token receives {ok:false}', async () => {
    const root = makeTempRoot();
    initToken(root);
    const srv = createIpcServer(root);
    servers.push(srv);
    await srv.listen();

    // Send a token that is valid format but wrong value.
    const result = await exchange(srv.path, { token: 'a'.repeat(64) });
    expect(result.ok).toBe(false);
  });

  it('connection with missing token field is rejected', async () => {
    const root = makeTempRoot();
    initToken(root);
    const srv = createIpcServer(root);
    servers.push(srv);
    await srv.listen();

    // Send a valid JSON object but without a `token` key.
    const result = await exchange(srv.path, { not_a_token: 'value' });
    expect(result.ok).toBe(false);
  });

  it('connection with malformed JSON is rejected', async () => {
    const root = makeTempRoot();
    initToken(root);
    const srv = createIpcServer(root);
    servers.push(srv);
    await srv.listen();

    // Send a raw string that is not valid JSON.
    const result = await exchange(srv.path, 'this-is-not-json');
    expect(result.ok).toBe(false);
  });

  // ── Token rotation on a running server ──────────────────────────────────────

  it('rotated token: old token rejected, new token accepted on same server', async () => {
    const root = makeTempRoot();
    const oldToken = initToken(root);
    const srv = createIpcServer(root);
    servers.push(srv);
    await srv.listen();

    // Old token works before rotation.
    const before = await exchange(srv.path, { token: oldToken });
    expect(before.ok).toBe(true);

    // Rotate — server is still running, no restart.
    const newToken = initToken(root, true);

    // Old token is now rejected (server reads token fresh on each connection).
    const withOld = await exchange(srv.path, { token: oldToken });
    expect(withOld.ok).toBe(false);

    // New token is accepted.
    const withNew = await exchange(srv.path, { token: newToken });
    expect(withNew.ok).toBe(true);
  });

  // ── Concurrent connections ───────────────────────────────────────────────────

  it('two concurrent correct-token connections both succeed', async () => {
    const root = makeTempRoot();
    const token = initToken(root);
    const srv = createIpcServer(root);
    servers.push(srv);
    await srv.listen();

    const [r1, r2] = await Promise.all([
      exchange(srv.path, { token }),
      exchange(srv.path, { token }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});
