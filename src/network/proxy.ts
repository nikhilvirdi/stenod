import * as mockttp from 'mockttp';
import type { Mockttp, CompletedRequest } from 'mockttp';

/**
 * Phase 12.2 — Local HTTPS Proxy + Provider Allowlist
 *
 * SSOT §6.1 (opt-in tier):
 *   "Routes traffic via HTTP_PROXY/HTTPS_PROXY, allowlisting known AI
 *    provider domains only (api.anthropic.com, api.openai.com,
 *    generativelanguage.googleapis.com, etc.) — everything else passes
 *    through untouched and unlogged. This allowlist is plain, readable
 *    code, independently verifiable by anyone who installs the tool."
 *
 * This module builds ONLY the proxy + allowlist mechanism, as a standalone,
 * directly-testable capability. It does NOT get invoked from `stenod
 * init`/`start`/`enable-network-capture` (that CLI wiring is Phase 12.4) and
 * does NOT do anything with SSE `.tee()`ing or `PROVIDER_CAPTURE` graph node
 * creation (that's Phase 12.3) — `getCapturedRequests()` below is the seam
 * a later phase will consume, not graph-node logic itself.
 *
 * ENFORCEMENT IS TWO-LAYERED, DELIBERATELY:
 *
 *   1. TLS-layer (`tlsInterceptOnly`, a real mockttp HTTPS option — see
 *      node_modules/mockttp/dist/mockttp.d.ts): TLS connections to any
 *      hostname NOT in `allowedDomains` are never decrypted at all — they
 *      are relayed as raw encrypted bytes straight to the real destination.
 *      This is the strongest possible "untouched and unlogged" guarantee
 *      for HTTPS traffic: non-allowlisted domains are never visible to any
 *      of our JS-level code, not just "seen but discarded".
 *
 *   2. Application-layer (the `allowedDomains.includes(...)` check in the
 *      `request` event handler below): `tlsInterceptOnly` only governs TLS
 *      connections. A client proxying a *plain* `http://` request (no TLS
 *      at all) reaches our HTTP rule handling regardless of hostname, since
 *      there's no TLS handshake for `tlsInterceptOnly` to gate. The single
 *      `forAnyRequest().thenPassThrough()` rule below still forwards such
 *      requests untouched (so proxying itself isn't broken for the rest of
 *      the developer's traffic), but the explicit hostname check is what
 *      keeps them out of `getCapturedRequests()` — this is the "plain,
 *      readable code, independently verifiable" enforcement SSOT asks for:
 *      a single, auditable allowlist check, not just trust in an opaque
 *      library flag.
 *
 * Uses exactly `mockttp` (locked dependency, 4.4.2), per the phase's Build
 * instruction. Reuses Phase 12.1's `generateRootCa()`-shaped `{ certPem,
 * keyPem }` CA material as-is (mockttp's `CertDataOptions` expects `{ key,
 * cert }`) — this module does not generate or modify any certificate.
 */

/**
 * The exact, fixed AI-provider domain allowlist, per SSOT §6.1. Deliberately
 * a plain top-level constant — not read from config/env/CLI — so it stays
 * "independently verifiable by anyone who installs the tool" by simply
 * reading this file, matching the same static-not-configurable spirit as
 * the compiler's λ weights.
 */
export const PROVIDER_ALLOWLIST: readonly string[] = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
];

/** A minimal, PEM-only view of a CA — matches `GeneratedRootCa` from `./ca.js` without importing its full surface. */
export interface ProxyCa {
  certPem: string;
  keyPem: string;
}

/** What gets recorded for a request to an allowlisted domain — the "visible to the daemon" data. */
export interface CapturedProviderRequest {
  id: string;
  method: string;
  hostname: string;
  url: string;
  /** Epoch ms, from mockttp's own `timingEvents.startTimestamp`. */
  timestamp: number;
}

export interface ProviderCaptureProxyOptions {
  /**
   * Skips upstream TLS certificate validation on the proxy→upstream leg of
   * passthrough connections.
   *
   * NEVER set this in production. It exists solely so this module's own
   * tests can point an "allowlisted" domain at a local, self-signed mock
   * upstream server without ever making a real network call — see
   * `proxy.test.ts`'s header for why. Defaults to false/unset, which is the
   * only value Phase 12.4's future production wiring will ever pass.
   */
  ignoreUpstreamHttpsErrors?: boolean;
}

export interface ProviderCaptureProxy {
  /** The underlying mockttp instance, exposed for callers that need `.url`/`.proxyEnv`/etc. */
  readonly server: Mockttp;
  /** Starts the proxy. Picks a random free port if `port` is omitted. */
  start(port?: number): Promise<void>;
  /** Stops the proxy and releases its port. */
  stop(): Promise<void>;
  /** Requests captured so far — only ever contains entries for `allowedDomains` hosts. */
  getCapturedRequests(): CapturedProviderRequest[];
}

/**
 * Builds (but does not start) a local HTTPS interception proxy that
 * allowlists `allowedDomains` (defaulting to `PROVIDER_ALLOWLIST`).
 *
 * `ca` must be a root CA — reuse Phase 12.1's `generateRootCa()` output.
 * This function does not generate, persist, or install any certificate.
 */
export function createProviderCaptureProxy(
  ca: ProxyCa,
  allowedDomains: readonly string[] = PROVIDER_ALLOWLIST,
  options: ProviderCaptureProxyOptions = {}
): ProviderCaptureProxy {
  const server = mockttp.getLocal({
    https: {
      key: ca.keyPem,
      cert: ca.certPem,
      // The TLS-layer half of the two-layer enforcement described above:
      // hostnames not in this list are never decrypted at all.
      tlsInterceptOnly: allowedDomains.map((hostname) => ({ hostname })),
    },
  });

  const capturedRequests: CapturedProviderRequest[] = [];

  return {
    server,

    async start(port?: number): Promise<void> {
      await server.start(port);

      // The application-layer half of the two-layer enforcement: recorded
      // only if the request's destination hostname is actually allowlisted.
      await server.on('request', (req: CompletedRequest) => {
        if (!allowedDomains.includes(req.destination.hostname)) return;

        capturedRequests.push({
          id: req.id,
          method: req.method,
          hostname: req.destination.hostname,
          url: req.url,
          timestamp: req.timingEvents.startTimestamp,
        });
      });

      // A single rule, matching every request that reaches this layer
      // (which, thanks to tlsInterceptOnly, is already only allowlisted
      // HTTPS traffic plus any plain-HTTP traffic — see module header).
      // Passing through untouched is correct for both: allowlisted traffic
      // must reach its real destination unmodified, and non-allowlisted
      // plain-HTTP traffic must not be broken by proxying it, even though
      // it's excluded from capture above.
      await server
        .forAnyRequest()
        .thenPassThrough(
          options.ignoreUpstreamHttpsErrors ? { ignoreHostHttpsErrors: true } : undefined
        );
    },

    async stop(): Promise<void> {
      await server.stop();
    },

    getCapturedRequests(): CapturedProviderRequest[] {
      return [...capturedRequests];
    },
  };
}
