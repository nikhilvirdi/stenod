import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { generateRootCa } from './ca.js';
import { createProviderCaptureProxy } from './proxy.js';
import { writeProviderCaptureNode, attachProviderCapture } from './provider-capture.js';

/**
 * Phase 12.3 — SSE `.tee()` + `PROVIDER_CAPTURE` Node Creation Tests
 *
 * WORKPLAN "Done when" checklist under test:
 *   [ ] Caller-facing stream is byte-identical to the unintercepted case
 *   [ ] Daemon-facing stream correctly produces PROVIDER_CAPTURE nodes
 *   [ ] No FSM state change results from this
 *
 * ZERO REAL NETWORK CALLS: same rationale and harness style as
 * `proxy.test.ts` — a local mock HTTPS "upstream" (bound to 127.0.0.1 only)
 * stands in for a real AI provider, reached through a raw CONNECT + TLS
 * tunnel built from Node built-ins, never the real internet.
 */

// ── Test helpers (mirrors proxy.test.ts) ─────────────────────────────────

/** A fixed multi-event SSE body, standing in for a real provider's streamed response. */
const SSE_BODY = [
  'event: message\ndata: {"delta":"Hello"}\n\n',
  'event: message\ndata: {"delta":", world"}\n\n',
  'event: done\ndata: {}\n\n',
].join('');

function startMockUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const { certPem, keyPem } = generateRootCa();
    const server = createHttpsServer({ key: keyPem, cert: certPem }, (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Content-Length': Buffer.byteLength(SSE_BODY),
      });
      res.end(SSE_BODY);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a bound TCP address'));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function connectThroughProxy(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`CONNECT tunnel failed: HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
}

function tlsOverTunnel(
  tunnelSocket: Socket,
  sniHost: string | undefined,
  opts: { caPem?: string; rejectUnauthorized?: boolean },
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect(
      {
        socket: tunnelSocket,
        ...(sniHost !== undefined ? { servername: sniHost } : {}),
        ca: opts.caPem,
        rejectUnauthorized: opts.rejectUnauthorized ?? true,
      },
      () => resolve(tlsSocket),
    );
    tlsSocket.on('error', reject);
  });
}

/** Sends a minimal raw HTTP/1.1 GET and resolves with the parsed status + raw body bytes. */
function rawHttpGet(
  socket: Socket | TLSSocket,
  host: string,
  path = '/',
): Promise<{ statusCode: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks);
      const headerEnd = raw.indexOf('\r\n\r\n');
      const headerPart = headerEnd === -1 ? raw.toString('utf8') : raw.slice(0, headerEnd).toString('utf8');
      const body = headerEnd === -1 ? Buffer.alloc(0) : raw.slice(headerEnd + 4);
      const statusLine = headerPart.split('\r\n')[0] ?? '';
      const statusCode = Number(statusLine.split(' ')[1]);
      resolve({ statusCode, body });
    });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
}

/**
 * Connects directly to the mock upstream, bypassing the proxy entirely.
 * The upstream presents its own self-signed cert (a fresh, unrelated
 * `generateRootCa()` call inside `startMockUpstream` — it plays no CA role
 * there, just a validly-shaped cert), so — same as `proxy.test.ts`'s
 * non-allowlisted-domain test — validation is skipped rather than trusting
 * an unrelated CA. This is purely a byte-comparison harness, not a TLS
 * validation test.
 */
async function fetchDirect(port: number, path: string): Promise<Buffer> {
  const tlsSocket = await new Promise<TLSSocket>((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => resolve(socket));
    socket.on('error', reject);
  });
  const { body } = await rawHttpGet(tlsSocket, '127.0.0.1', path);
  return body;
}

/**
 * Connects through the proxy. For the allowlisted `localhost` target,
 * mockttp intercepts TLS and mints its own leaf cert signed by the proxy's
 * CA, so `caPem` (the proxy's CA) is trusted with SNI set to `targetHost` —
 * same pattern as `proxy.test.ts`'s allowlisted-domain test. For
 * non-allowlisted targets, `tlsInterceptOnly` means the connection is
 * relayed raw straight to the upstream's own self-signed cert, so
 * validation is skipped instead (same as `fetchDirect`).
 */
async function fetchThroughProxy(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  caPem: string | undefined,
  path: string,
): Promise<Buffer> {
  const tunnel = await connectThroughProxy(proxyPort, targetHost, targetPort);
  const tlsSocket = caPem
    ? await tlsOverTunnel(tunnel, targetHost, { caPem })
    : await tlsOverTunnel(tunnel, undefined, { rejectUnauthorized: false });
  const { body } = await rawHttpGet(tlsSocket, targetHost, path);
  return body;
}

describe('network/provider-capture — Phase 12.3', () => {
  let tempDir: string;
  let db: Database.Database | undefined;
  const proxies: Array<ReturnType<typeof createProviderCaptureProxy>> = [];
  const upstreams: Array<{ close: () => Promise<void> }> = [];

  function migratedDb(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-provider-capture-test-'));
    db = openDatabase(join(tempDir, 'graph.db'));
    runMigrations(db);
    return db;
  }

  afterEach(async () => {
    await Promise.all(proxies.map((p) => p.stop()));
    proxies.length = 0;
    await Promise.all(upstreams.map((u) => u.close()));
    upstreams.length = 0;
    db?.close();
    db = undefined;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('caller-facing stream is byte-identical to the unintercepted case', async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);
    const testDb = migratedDb();

    const proxyCa = generateRootCa();
    const proxy = createProviderCaptureProxy(proxyCa, ['localhost'], {
      ignoreUpstreamHttpsErrors: true,
    });
    proxies.push(proxy);
    await proxy.start();
    attachProviderCapture(proxy, testDb, new SessionFsm());

    const directBody = await fetchDirect(upstream.port, '/direct');
    const proxiedBody = await fetchThroughProxy(
      proxy.server.port,
      'localhost',
      upstream.port,
      proxyCa.certPem,
      '/direct',
    );

    // Byte-identical, not just string-equal — proves the passthrough branch
    // of the tee is unmodified even with a `response` listener attached.
    expect(proxiedBody.equals(directBody)).toBe(true);
    expect(proxiedBody.toString('utf8')).toContain(SSE_BODY);
  });

  it('daemon-facing stream produces a PROVIDER_CAPTURE node for an allowlisted response', async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);
    const testDb = migratedDb();

    const proxyCa = generateRootCa();
    const proxy = createProviderCaptureProxy(proxyCa, ['localhost'], {
      ignoreUpstreamHttpsErrors: true,
    });
    proxies.push(proxy);
    await proxy.start();
    const attachment = attachProviderCapture(proxy, testDb, new SessionFsm());

    await fetchThroughProxy(proxy.server.port, 'localhost', upstream.port, proxyCa.certPem, '/hello');
    await attachment.whenIdle();

    const rows = testDb
      .prepare("SELECT * FROM graph_nodes WHERE type = 'PROVIDER_CAPTURE'")
      .all() as Array<{
      id: string;
      type: string;
      content: string;
      status: string;
      source_file: string | null;
      fsm_state: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('ACTIVE');
    expect(rows[0]!.content).toBe(SSE_BODY);
    expect(rows[0]!.source_file).toContain('/hello');
  });

  it('a non-allowlisted response produces no PROVIDER_CAPTURE node', async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);
    const testDb = migratedDb();

    const proxyCa = generateRootCa();
    // 'localhost' is allowlisted; '127.0.0.1' (same physical server, different
    // apparent hostname) deliberately is not — same boundary proof as
    // proxy.test.ts's own non-allowlisted-domain test.
    const proxy = createProviderCaptureProxy(proxyCa, ['localhost'], {
      ignoreUpstreamHttpsErrors: true,
    });
    proxies.push(proxy);
    await proxy.start();
    const attachment = attachProviderCapture(proxy, testDb, new SessionFsm());

    await fetchThroughProxy(proxy.server.port, '127.0.0.1', upstream.port, undefined, '/untouched');
    await attachment.whenIdle();

    const rows = testDb.prepare("SELECT * FROM graph_nodes WHERE type = 'PROVIDER_CAPTURE'").all();
    expect(rows).toEqual([]);
  });

  it('does not drive any FSM transition', async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);
    const testDb = migratedDb();

    const proxyCa = generateRootCa();
    const proxy = createProviderCaptureProxy(proxyCa, ['localhost'], {
      ignoreUpstreamHttpsErrors: true,
    });
    proxies.push(proxy);
    await proxy.start();

    // Start the FSM in a known non-idle state to prove a PROVIDER_CAPTURE
    // write neither advances it further nor resets it.
    const fsm = new SessionFsm();
    fsm.apply('ERROR');
    expect(fsm.state).toBe('RUNTIME_ERR');

    const attachment = attachProviderCapture(proxy, testDb, fsm);
    await fetchThroughProxy(proxy.server.port, 'localhost', upstream.port, proxyCa.certPem, '/panic');
    await attachment.whenIdle();

    expect(fsm.state).toBe('RUNTIME_ERR');

    const row = testDb
      .prepare("SELECT fsm_state FROM graph_nodes WHERE type = 'PROVIDER_CAPTURE'")
      .get() as { fsm_state: string };
    expect(row.fsm_state).toBe('RUNTIME_ERR');
  });

  it('writeProviderCaptureNode() snapshots fsm.state without calling fsm.apply()', () => {
    const testDb = migratedDb();
    const fsm = new SessionFsm();
    fsm.apply('ERROR');
    fsm.apply('SAVE');
    expect(fsm.state).toBe('DOC_EDIT');

    const result = writeProviderCaptureNode(testDb, fsm, 'some provider payload', 'https://api.anthropic.com/v1/messages');

    expect(fsm.state).toBe('DOC_EDIT'); // unchanged
    expect(result.fsmState).toBe('DOC_EDIT');
    expect(result.created).toBe(true);

    const row = testDb.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(result.id) as {
      type: string;
      status: string;
      fsm_state: string;
      source_file: string | null;
    };
    expect(row.type).toBe('PROVIDER_CAPTURE');
    expect(row.status).toBe('ACTIVE');
    expect(row.fsm_state).toBe('DOC_EDIT');
    expect(row.source_file).toBe('https://api.anthropic.com/v1/messages');
  });

  it('id-collision: identical content twice is INSERT OR IGNORE, not overwritten', () => {
    const testDb = migratedDb();
    const fsm = new SessionFsm();

    const first = writeProviderCaptureNode(testDb, fsm, 'identical payload', 'https://api.openai.com/v1/chat');
    const second = writeProviderCaptureNode(testDb, fsm, 'identical payload', 'https://api.openai.com/v1/chat');

    expect(first.id).toBe(second.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const rows = testDb.prepare('SELECT * FROM graph_nodes WHERE id = ?').all(first.id);
    expect(rows).toHaveLength(1);
  });
});
