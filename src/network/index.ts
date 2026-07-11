// Network capture module boundary — Milestone 12 (opt-in AI-provider capture tier).
// Phase 12.1: local CA generation + trust store install, as a standalone
// capability. Not yet wired into the CLI (`enable-network-capture` is
// Phase 12.4) or the proxy itself (Phase 12.2).

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
