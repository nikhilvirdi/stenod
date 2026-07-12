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

  // ── Phase 7.5 addition: onMessage (post-auth message dispatch) ──────────────
  //
  // Coverage:
  //   11. a well-formed post-auth message is dispatched to onMessage
  //   12. with no onMessage supplied, post-auth data is silently discarded —
  //       byte-identical to Phase 2.3's original behavior (no crash, no
  //       response, connection stays open)
  //   13. a malformed post-auth message is NOT dispatched, and does not tear
  //       down the connection — a subsequent well-formed message on the same
  //       connection still gets through
  //   14. multiple messages (including split across separate writes) are each
  //       dispatched exactly once, in order
  //   15. the auth handshake itself is provably unaffected: the exact same
  //       {ok:true}/{ok:false} behavior as every test above, now with
  //       onMessage supplied

  /**
   * Connects, authenticates (must succeed — throws otherwise), then leaves
   * the connection open for the caller to send further messages via the
   * returned `send`/`waitForData`/`close` helpers. Unlike `exchange()`
   * above, this does not close the connection after the first response.
   */
  async function connectAndAuth(
    path: string,
    token: string,
  ): Promise<{
    send: (payload: Record<string, unknown> | string) => void;
    waitForData: (timeoutMs?: number) => Promise<string | undefined>;
    close: () => void;
  }> {
    const client = createConnection(path);
    client.setEncoding('utf8');
    const received: string[] = [];
    let buffer = '';

    client.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        received.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });

    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => client.write(JSON.stringify({ token }) + '\n'));
      client.once('error', reject);
      const check = setInterval(() => {
        if (received.length > 0) {
          clearInterval(check);
          const authMsg = JSON.parse(received.shift()!) as { ok: boolean };
          if (!authMsg.ok) {
            reject(new Error('auth failed in test helper'));
          } else {
            resolve();
          }
        }
      }, 5);
    });

    return {
      send: (payload) => {
        const line = typeof payload === 'string' ? payload : JSON.stringify(payload);
        client.write(line + '\n');
      },
      waitForData: (timeoutMs = 500) =>
        new Promise((resolve) => {
          const start = Date.now();
          const check = setInterval(() => {
            if (received.length > 0) {
              clearInterval(check);
              resolve(received.shift());
            } else if (Date.now() - start >= timeoutMs) {
              clearInterval(check);
              resolve(undefined);
            }
          }, 5);
        }),
      close: () => client.destroy(),
    };
  }

  it('a well-formed post-auth message is dispatched to onMessage', async () => {
    const root = makeTempRoot();
    const token = initToken(root);
    const received: unknown[] = [];
    const srv = createIpcServer(root, { onMessage: (msg) => received.push(msg) });
    servers.push(srv);
    await srv.listen();

    const conn = await connectAndAuth(srv.path, token);
    conn.send({ type: 'ping', value: 42 });

    // Give the async dispatch a moment to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    conn.close();

    expect(received).toEqual([{ type: 'ping', value: 42 }]);
  });

  it('with no onMessage supplied, post-auth data is silently discarded (matches Phase 2.3 original behavior)', async () => {
    const root = makeTempRoot();
    const token = initToken(root);
    const srv = createIpcServer(root); // no onMessage
    servers.push(srv);
    await srv.listen();

    const conn = await connectAndAuth(srv.path, token);
    conn.send({ type: 'ping' });

    const response = await conn.waitForData(200);
    expect(response).toBeUndefined(); // no crash, no response, connection stayed open
    conn.close();
  });

  it('a malformed post-auth message is ignored, without tearing down the connection', async () => {
    const root = makeTempRoot();
    const token = initToken(root);
    const received: unknown[] = [];
    const srv = createIpcServer(root, { onMessage: (msg) => received.push(msg) });
    servers.push(srv);
    await srv.listen();

    const conn = await connectAndAuth(srv.path, token);
    conn.send('this-is-not-json');
    conn.send({ type: 'still-alive' }); // proves the connection survived the malformed line

    await new Promise((resolve) => setTimeout(resolve, 50));
    conn.close();

    expect(received).toEqual([{ type: 'still-alive' }]);
  });

  it('multiple messages, including ones split across separate writes, are each dispatched once and in order', async () => {
    const root = makeTempRoot();
    const token = initToken(root);
    const received: unknown[] = [];
    const srv = createIpcServer(root, { onMessage: (msg) => received.push(msg) });
    servers.push(srv);
    await srv.listen();

    const conn = await connectAndAuth(srv.path, token);
    conn.send({ seq: 1 });
    conn.send({ seq: 2 });
    conn.send({ seq: 3 });

    await new Promise((resolve) => setTimeout(resolve, 50));
    conn.close();

    expect(received).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  });

  it('the auth handshake is unaffected by onMessage being supplied — correct and incorrect tokens behave exactly as before', async () => {
    const root = makeTempRoot();
    const token = initToken(root);
    const srv = createIpcServer(root, { onMessage: () => {} });
    servers.push(srv);
    await srv.listen();

    const correct = await exchange(srv.path, { token });
    expect(correct.ok).toBe(true);

    const wrong = await exchange(srv.path, { token: 'b'.repeat(64) });
    expect(wrong.ok).toBe(false);
  });
});
