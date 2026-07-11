// Network capture module boundary — Milestone 12 (opt-in AI-provider capture tier).
// Phase 12.1: local CA generation + trust store install, as a standalone
// capability. Phase 12.2: local HTTPS proxy + provider allowlist, also
// standalone. Phase 12.3: SSE `.tee()` + PROVIDER_CAPTURE node creation,
// consuming Phase 12.2's `server`/`getCapturedRequests()` seams. Phase
// 12.4: wires 12.1-12.3 together for `stenod enable-network-capture`
// (CLI action lives in `program.ts`; `enable-capture.ts` is the testable
// orchestration this barrel now also exports).

export { generateRootCa, persistRootCa, caDir, ROOT_CA_COMMON_NAME } from './ca.js';
export type { GeneratedRootCa, PersistedRootCa } from './ca.js';

export {
  buildInstallCommand,
  buildVerifyCommand,
  installTrustStore,
  verifyTrustStoreInstall,
  UnsupportedPlatformError,
} from './trust-store.js';
export type {
  TrustStoreOptions,
  TrustStoreCommand,
  SupportedTrustStoreCommand,
  UnsupportedTrustStoreCommand,
  TrustStoreCommandResult,
} from './trust-store.js';

export { createProviderCaptureProxy, PROVIDER_ALLOWLIST } from './proxy.js';
export type {
  ProxyCa,
  CapturedProviderRequest,
  ProviderCaptureProxyOptions,
  ProviderCaptureProxy,
} from './proxy.js';

export { writeProviderCaptureNode, attachProviderCapture } from './provider-capture.js';
export type { ProviderCaptureWriteResult, ProviderCaptureAttachment } from './provider-capture.js';

export { enableNetworkCapture, stopNetworkCapture } from './enable-capture.js';
export type { NetworkCaptureHandle } from './enable-capture.js';
