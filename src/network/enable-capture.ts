import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { stenoDir } from '../workspace/sandbox.js';
import { SessionFsm } from '../lifecycle/index.js';
import { generateRootCa, persistRootCa } from './ca.js';
import type { PersistedRootCa } from './ca.js';
import { installTrustStore } from './trust-store.js';
import type { TrustStoreCommandResult } from './trust-store.js';
import { createProviderCaptureProxy } from './proxy.js';
import type { ProviderCaptureProxy } from './proxy.js';
import { attachProviderCapture } from './provider-capture.js';
import type { ProviderCaptureAttachment } from './provider-capture.js';

/**
 * Phase 12.4 — Wire `stenod enable-network-capture`
 *
 * SSOT §6.1 (opt-in tier): generates a local root CA, installs it into the
 * OS trust store, starts a local HTTPS proxy allowlisting only known
 * AI-provider domains, and feeds captured responses into the causal graph
 * as `PROVIDER_CAPTURE` nodes — all "only when this command is explicitly
 * run — never silently."
 *
 * This file wires Phases 12.1 (`ca.ts`/`trust-store.ts`), 12.2 (`proxy.ts`),
 * and 12.3 (`provider-capture.ts`) together, in that exact sequence, as
 * plain glue: it does not generate certs, build trust-store commands, run
 * the proxy, or write graph nodes itself — every one of those steps is
 * delegated to its own already-built, already-Verified function. Mirrors
 * `daemon/lifecycle.ts`'s `startDaemon()`/`stopDaemon()` shape (a start
 * function returning a handle, a matching stop function accepting that
 * handle) — the same precedent this codebase already uses for a
 * long-running, foreground process wired up by `program.ts`.
 *
 * Do NOT call this from `stenod init`/`start` — opt-in only, triggered
 * exclusively by `stenod enable-network-capture` (CLI wiring in
 * `program.ts`). Do NOT persist or restore `HTTP_PROXY`/`HTTPS_PROXY` here:
 * a child process cannot set environment variables in the shell that
 * invoked it, so the CLI layer prints the proxy URL for the user to export
 * themselves — see `program.ts`'s `enable-network-capture` action.
 */

export interface NetworkCaptureHandle {
  projectRoot: string;
  db: Database.Database;
  /** Phase 12.1 output — the persisted (on-disk) root CA. */
  ca: PersistedRootCa;
  /** Phase 12.1 output — result of the OS trust-store install attempt. */
  trustStoreResult: TrustStoreCommandResult;
  /** Phase 12.2 output — the running proxy. */
  proxy: ProviderCaptureProxy;
  /** Phase 12.3 output — the attached daemon-facing capture branch. */
  capture: ProviderCaptureAttachment;
}

/**
 * Runs the opt-in network-capture tier's full startup sequence for
 * `projectRoot`, in order:
 *   1. Phase 12.1: `generateRootCa()` -> `persistRootCa()` -> `installTrustStore()`.
 *   2. Phase 12.2: `createProviderCaptureProxy()`, then starts it.
 *   3. Phase 12.3: `attachProviderCapture()` on the now-started proxy.
 *
 * Caller is responsible for confirming a Stenod workspace already exists
 * (`stenod init`) before calling this — matches the precedent already set
 * by `handoff`/`reject`/`anchor`/`mcp`'s own CLI actions, all of which
 * perform that check in `program.ts` rather than in the orchestrating
 * function itself.
 *
 * `installTrustStore()`'s `UnsupportedPlatformError` (thrown on any
 * platform other than Linux/Mac, per Phase 12.1) is allowed to propagate
 * uncaught — its message is already a clear, user-facing explanation; the
 * CLI action catches it like any other error from this function.
 */
export async function enableNetworkCapture(projectRoot: string): Promise<NetworkCaptureHandle> {
  const db = openDatabase(join(stenoDir(projectRoot), 'graph.db'));

  // Everything after this point can throw (installTrustStore() throws
  // UnsupportedPlatformError on any non-Linux/Mac platform, before any
  // proxy is ever created) or reject (proxy.start()). Without this
  // try/catch, a failure partway through would leak whatever was already
  // opened — most importantly `db`, which nothing else would ever close.
  let proxy: ProviderCaptureProxy | undefined;
  try {
    runMigrations(db);
    const fsm = new SessionFsm();

    const rootCa = generateRootCa();
    const persisted = persistRootCa(projectRoot, rootCa);
    const trustStoreResult = installTrustStore(persisted.certPath);

    proxy = createProviderCaptureProxy(rootCa);
    await proxy.start();

    const capture = attachProviderCapture(proxy, db, fsm);

    return { projectRoot, db, ca: persisted, trustStoreResult, proxy, capture };
  } catch (err) {
    if (proxy) {
      await proxy.stop();
    }
    db.close();
    throw err;
  }
}

/**
 * Cleanly stops network capture started via `enableNetworkCapture()`:
 * drains any in-flight `PROVIDER_CAPTURE` writes, stops the proxy, then
 * closes the DB connection. Does NOT revert the OS trust-store install or
 * any proxy env-var instructions already given to the user — that full
 * revert is `stenod disable-network-capture`'s job (Phase 12.5), a
 * separate, explicit command, not an automatic side effect of stopping
 * this foreground process.
 */
export async function stopNetworkCapture(handle: NetworkCaptureHandle): Promise<void> {
  await handle.capture.whenIdle();
  await handle.proxy.stop();
  handle.db.close();
}
