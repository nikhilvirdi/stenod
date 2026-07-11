import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';
import { generateRootCa } from './ca.js';
import { createProviderCaptureProxy, PROVIDER_ALLOWLIST } from './proxy.js';

/**
 * Phase 12.2 — Local HTTPS Proxy + Provider Allowlist Tests
 *
 * WORKPLAN "Done when" checklist under test:
 *   [ ] Requests to allowlisted domains are visible to the daemon
 *   [ ] Requests to any other domain are confirmed NOT logged/captured
 *
 * ZERO REAL NETWORK CALLS: per CLAUDE.md's "zero network calls except the
 * explicitly opt-in AI-provider capture tier" — and even within that tier,
 * a *test* must never depend on actually reaching the real internet (not
 * deterministic, not safe to run in CI, and not actually testing our own
 * allowlist logic against the real api.anthropic.com). So instead of the
 * real production domains, these tests use `createProviderCaptureProxy()`'s
 * `allowedDomains` parameter (a plain dependency-injection seam — same
 * pattern as `platform`/`homeDir` in Phase 12.1's `trust-store.ts`) to
 * substitute a loopback-only "allowlisted" domain (`'localhost'`) and a
 * loopback-only "non-allowlisted" one (the literal IP `'127.0.0.1'` — same
 * physical machine, deliberately different apparent hostname, to prove the
 * allowlist *string* boundary itself). A single local mock HTTPS server
 * (`startMockUpstream`, bound to 127.0.0.1 only) stands in for "the real
 * provider" in both cases. The literal, production `PROVIDER_ALLOWLIST`
 * constant (the exact 3 SSOT domains) is separately asserted verbatim,
 * with no proxying involved, in the first test below.
 *
 * There is no `https-proxy-agent`-style dependency on the locked list, so
 * proxying is driven by hand: a raw HTTP CONNECT tunnel, then a TLS
 * handshake over that tunnel, then a hand-written minimal HTTP/1.1 GET —
 * using only Node built-ins (`node:http`, `node:tls`), mirroring exactly
 * how a real HTTPS-over-proxy client behaves at the protocol level.
 */

// ── Test helpers ───────────────────────────────────────────────────────

/**
 * A tiny local HTTPS server standing in for "the real provider". Bound to
 * 127.0.0.1 only — never reachable from outside this machine. Any
 * self-signed cert works here: every client below either explicitly trusts
 * it (`ignoreUpstreamHttpsErrors`, the proxy→upstream leg) or disables
 * validation directly (`rejectUnauthorized: false`, the raw-passthrough
 * client→upstream leg) — see each test for which applies. Reusing
 * `generateRootCa()` here is just a convenient way to get a validly-shaped
 * self-signed cert; it plays no CA role for this server.
 */
function startMockUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const { certPem, keyPem } = generateRootCa();
    const server = createHttpsServer({ key: keyPem, cert: certPem }, (req, res) => {
      const body = JSON.stringify({ upstream: true, path: req.url });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
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

/** Opens a raw HTTP CONNECT tunnel through the proxy to `targetHost:targetPort`, resolving with the still-unencrypted tunnel socket. */
function connectThroughProxy(
  proxyPort: number,
  targetHost: string,
  targetPort: number
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

/**
 * Performs a TLS handshake over an already-open CONNECT tunnel. Trusts
 * `caPem` if given; otherwise honors `rejectUnauthorized` directly.
 *
 * `sniHost` is optional and skipped for IP-literal targets: Node warns
 * (RFC 6066 deprecation) if SNI is set to a bare IP, and it isn't needed
 * here anyway — the mock upstream server presents a single, fixed
 * certificate regardless of SNI, and identity validation for IP-literal
 * connections is handled entirely via `rejectUnauthorized` instead.
 */
function tlsOverTunnel(
  tunnelSocket: Socket,
  sniHost: string | undefined,
  opts: { caPem?: string; rejectUnauthorized?: boolean }
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect(
      {
        socket: tunnelSocket,
        ...(sniHost !== undefined ? { servername: sniHost } : {}),
        ca: opts.caPem,
        rejectUnauthorized: opts.rejectUnauthorized ?? true,
      },
      () => resolve(tlsSocket)
    );
    tlsSocket.on('error', reject);
  });
}

/** Sends a minimal raw HTTP/1.1 GET over an already-open socket (plain or TLS) and resolves with the parsed status + body. */
function rawHttpGet(
  socket: Socket | TLSSocket,
  host: string,
  path = '/'
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      raw += chunk;
    });
    socket.on('error', reject);
    socket.on('end', () => {
      const headerEnd = raw.indexOf('\r\n\r\n');
      const headerPart = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
      const body = headerEnd === -1 ? '' : raw.slice(headerEnd + 4);
      const statusLine = headerPart.split('\r\n')[0] ?? '';
      const statusCode = Number(statusLine.split(' ')[1]);
      resolve({ statusCode, body });
    });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('network/proxy — Phase 12.2', () => {
  const proxies: Array<ReturnType<typeof createProviderCaptureProxy>> = [];
  const upstreams: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(proxies.map((p) => p.stop()));
    proxies.length = 0;
    await Promise.all(upstreams.map((u) => u.close()));
    upstreams.length = 0;
  });

  it('exports the exact SSOT-specified provider allowlist, verbatim', () => {
    expect(PROVIDER_ALLOWLIST).toEqual([
      'api.anthropic.com',
      'api.openai.com',
      'generativelanguage.googleapis.com',
    ]);
  });

  it('requests to an allowlisted domain are visible to the daemon (captured), and reach the real upstream untouched', async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);

    const proxyCa = generateRootCa();
    const proxy = createProviderCaptureProxy(proxyCa, ['localhost'], {
      ignoreUpstreamHttpsErrors: true,
    });
    proxies.push(proxy);
    await proxy.start();

    const tunnel = await connectThroughProxy(proxy.server.port, 'localhost', upstream.port);
    const tlsSocket = await tlsOverTunnel(tunnel, 'localhost', { caPem: proxyCa.certPem });
    const response = await rawHttpGet(tlsSocket, 'localhost', '/hello');

    // Untouched: the real upstream's response reached the client unmodified.
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ upstream: true, path: '/hello' });

    // Visible to the daemon: exactly one captured request, for this host.
    const captured = proxy.getCapturedRequests();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.hostname).toBe('localhost');
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.url).toContain('/hello');
  });

  it('requests to a non-allowlisted domain pass through untouched but are confirmed NOT captured', async () => {
    const upstream = await startMockUpstream();
    upstreams.push(upstream);

    const proxyCa = generateRootCa();
    // 'localhost' is allowlisted; '127.0.0.1' (the very same physical
    // server, reached under a different apparent hostname) deliberately is
    // not — this proves the allowlist boundary itself, not merely "this
    // particular server happens to be reachable".
    const proxy = createProviderCaptureProxy(proxyCa, ['localhost'], {
      ignoreUpstreamHttpsErrors: true,
    });
    proxies.push(proxy);
    await proxy.start();

    const tunnel = await connectThroughProxy(proxy.server.port, '127.0.0.1', upstream.port);
    // Not allowlisted -> tlsInterceptOnly means mockttp never decrypts this
    // connection at all (raw byte relay) -> the client's TLS handshake is
    // directly with the real mock upstream's own self-signed certificate,
    // not a mockttp-minted one chained to the proxy's CA — so there is no
    // CA to trust here, only a direct (and deliberately unchecked) peer cert.
    const tlsSocket = await tlsOverTunnel(tunnel, undefined, { rejectUnauthorized: false });
    const response = await rawHttpGet(tlsSocket, '127.0.0.1', '/untouched');

    // Untouched: still reaches the real upstream and gets its real response.
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ upstream: true, path: '/untouched' });

    // Unlogged: nothing was captured for this connection.
    expect(proxy.getCapturedRequests()).toEqual([]);
  });
});
