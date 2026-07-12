import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { caDir } from './ca.js';
import { uninstallTrustStore, verifyTrustStoreInstall } from './trust-store.js';
import type { TrustStoreCommandResult } from './trust-store.js';

/**
 * Phase 12.5 — Wire `stenod disable-network-capture`
 *
 * SSOT §6.1: "`stenod disable-network-capture` fully reverts the CA and
 * proxy settings — a trust ask needs an equally clear undo path."
 * SSOT §10: "Full opt-out path for the network tier, including CA removal
 * — a trust ask needs an equally clear undo."
 *
 * This is a standalone, separately-invoked command — NOT the same process
 * as any still-running `stenod enable-network-capture` (Phase 12.4). That
 * command's `NetworkCaptureHandle` only exists in-memory, inside that other
 * process; there is no IPC between the two. This module instead works
 * entirely from the CA Phase 12.1's `persistRootCa()` already wrote to disk
 * (`caDir(projectRoot)/rootCA.pem`), so it correctly reverts trust-store
 * state even if the `enable-network-capture` process that installed it has
 * already exited (Ctrl+C, crash, closed terminal) — it must not depend on
 * that process still being alive.
 *
 * Uses Phase 12.1's `uninstallTrustStore()`/`verifyTrustStoreInstall()`
 * (the latter reused as-is to *confirm* removal — no new "verify it's gone"
 * function was needed, since a verify command that no longer finds the cert
 * already is that confirmation) rather than anything from `proxy.ts`/
 * `provider-capture.ts` — this phase only reverts persisted OS/disk state,
 * it does not touch a running proxy (there is none to touch from a
 * separate process).
 *
 * After a confirmed-clean removal, the persisted `.stenod/ca/` directory is
 * deleted entirely: (1) makes a second `disable-network-capture` call a
 * clean, idempotent no-op instead of re-attempting removal of an
 * already-removed trust-store entry (which `certutil -D`/
 * `security delete-certificate` would otherwise report as a failure), and
 * (2) guarantees the next `enable-network-capture` starts from a genuinely
 * clean slate — this phase's own "fresh enable -> disable -> enable cycle
 * works cleanly (no leftover state)" Done-when item. If removal is not
 * confirmed, the persisted CA is left in place rather than deleted, since
 * discarding it while it might still be trusted by the OS would make a
 * retry harder, not easier.
 *
 * Does NOT unset `HTTP_PROXY`/`HTTPS_PROXY` in the user's shell — same
 * child-process constraint already documented in `enable-capture.ts`: a
 * child process cannot mutate the environment of the shell that invoked
 * it. The CLI layer (`program.ts`) prints clear unset instructions instead,
 * symmetric to how `enable-network-capture` prints set instructions.
 */

export interface DisableNetworkCaptureResult {
  /** False if there was no persisted CA on disk at all — nothing to revert. */
  wasEnabled: boolean;
  certPath: string;
  /** Result of the OS trust-store removal attempt. Undefined when `wasEnabled` is false. */
  uninstallResult?: TrustStoreCommandResult;
  /**
   * True once a post-removal `verifyTrustStoreInstall()` call confirms the
   * cert is genuinely gone (the verify command itself no longer finds it).
   * Always true when `wasEnabled` is false — nothing was ever there.
   */
  confirmedRemoved: boolean;
}

/**
 * Reverts everything `enableNetworkCapture()` (Phase 12.4) persisted for
 * `projectRoot`: removes the CA from the OS trust store, confirms removal,
 * then deletes the persisted CA directory from disk.
 *
 * `uninstallTrustStore()`/`verifyTrustStoreInstall()`'s `UnsupportedPlatformError`
 * (thrown on any platform other than Linux/Mac) is allowed to propagate
 * uncaught, exactly like `enableNetworkCapture()`'s own precedent — its
 * message is already a clear, user-facing explanation; the CLI action
 * catches it like any other error from this function.
 */
export function disableNetworkCapture(projectRoot: string): DisableNetworkCaptureResult {
  const dir = caDir(projectRoot);
  const certPath = join(dir, 'rootCA.pem');

  if (!existsSync(certPath)) {
    return { wasEnabled: false, certPath, confirmedRemoved: true };
  }

  const uninstallResult = uninstallTrustStore();
  const verify = verifyTrustStoreInstall();
  const confirmedRemoved = !verify.success;

  if (confirmedRemoved) {
    rmSync(dir, { recursive: true, force: true });
  }

  return { wasEnabled: true, certPath, uninstallResult, confirmedRemoved };
}
