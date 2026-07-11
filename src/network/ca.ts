import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import * as forge from 'node-forge';
import { stenoDir } from '../workspace/sandbox.js';

/**
 * Phase 12.1 — Local CA Generation
 *
 * SSOT §6.1 (opt-in tier):
 *   "Generates a local root CA, installed into the OS trust store only when
 *    this command is explicitly run — never silently."
 *
 * This module is responsible ONLY for generating and persisting the root CA
 * key material. It does NOT install anything into a trust store (see
 * `trust-store.ts`), does NOT get invoked from `stenod init`/`start`, and is
 * NOT wired into any CLI command yet — this is a standalone, explicitly-
 * invoked capability per the phase spec ("Do NOT: trigger this automatically
 * from init or start"). Importing this module has zero side effects: no key
 * is generated and no file is written until `generateRootCa()` /
 * `persistRootCa()` are called explicitly.
 *
 * DETERMINISM NOTE (documented per CLAUDE.md's non-negotiable constraint):
 * the project's determinism guarantee ("same input state → same output,
 * always") governs the capture→compile→manifest pipeline — the causal graph
 * and the Handoff Manifest it produces. It is not a ban on cryptographic
 * randomness inside the opt-in network-capture tier's trust material. A
 * deterministic (i.e. predictable) CA private key would be a critical
 * security hole: anyone who could guess or reconstruct it could mint trusted
 * certificates for any domain the user's machine now trusts. The randomness
 * here (RSA keypair, serial number) and the wall-clock read (validity
 * window) are therefore a deliberate, scoped exception — they never reach
 * `graph_nodes`/`graph_edges`/the compiler, and this module has no other
 * callers in this phase.
 *
 * Uses `node-forge` (locked dependency, 1.4.0) per the phase's Build
 * instruction and the user's explicit choice over `mockttp`'s built-in CA
 * generation, so cert fields (subject, extensions, validity) are directly
 * controlled here rather than inherited from mockttp's defaults. See
 * `node-forge.d.ts` for why a hand-written ambient declaration is used
 * instead of `@types/node-forge`.
 */

/** RSA key size for the root CA keypair. 2048 bits is the current baseline for CA keys. */
const KEY_SIZE_BITS = 2048;

/** How long the generated root CA certificate remains valid. */
const VALIDITY_YEARS = 10;

/**
 * `notBefore` is backdated by this much to tolerate clock skew between the
 * machine that generated the cert and any client validating it moments
 * later — a certificate whose validity window starts in the future would
 * spuriously fail validation on a client with a slightly slow clock.
 */
const NOT_BEFORE_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/** Subject/issuer are identical — this is what makes the certificate self-signed. */
const CA_SUBJECT_ATTRS: forge.pki.DistinguishedNameAttribute[] = [
  { name: 'commonName', value: 'Stenod Local CA' },
  { name: 'organizationName', value: 'Stenod' },
];

/** The exact `commonName` set above — exported so `trust-store.ts` can look the cert up by name without duplicating the string. */
export const ROOT_CA_COMMON_NAME = 'Stenod Local CA';

export interface GeneratedRootCa {
  /** PEM-encoded self-signed root CA certificate. */
  certPem: string;
  /** PEM-encoded RSA private key for the CA. Sensitive — see `persistRootCa()`'s file permissions. */
  keyPem: string;
}

/**
 * Generates a new self-signed root CA certificate + private key.
 *
 * Produces a genuine CA cert (not just a self-signed leaf): `basicConstraints
 * cA=true` and `keyUsage {keyCertSign, cRLSign}` are both set and marked
 * critical, per X.509's requirement that a certificate be explicitly marked
 * as a CA before it can validly sign other certificates. Both the subject
 * and issuer are set from the same attributes, and the cert is self-signed
 * with its own private key.
 *
 * Pure function: no filesystem or network access. Call `persistRootCa()` to
 * write the result to disk.
 */
export function generateRootCa(): GeneratedRootCa {
  const keys = forge.pki.rsa.generateKeyPair(KEY_SIZE_BITS);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;

  // X.509 serial numbers are unsigned in practice, but forge encodes the
  // hex string as a DER INTEGER, which is signed. A random byte whose high
  // bit is set would otherwise be misread as negative, so a leading zero
  // byte is prepended when needed — the standard fix for this class of
  // encoding, confirmed by round-tripping through openssl during design.
  const serialBytes = forge.random.getBytesSync(16);
  let serialHex = forge.util.bytesToHex(serialBytes);
  if (parseInt(serialHex[0]!, 16) >= 8) {
    serialHex = '00' + serialHex;
  }
  cert.serialNumber = serialHex;

  const notBefore = new Date(Date.now() - NOT_BEFORE_SKEW_MS);
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notBefore.getFullYear() + VALIDITY_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  cert.setSubject(CA_SUBJECT_ATTRS);
  cert.setIssuer(CA_SUBJECT_ATTRS);

  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

export interface PersistedRootCa {
  certPath: string;
  keyPath: string;
}

/** The `.stenod/ca/` directory for a given (already-resolved or resolvable) project root. */
export function caDir(projectRoot: string): string {
  return join(stenoDir(projectRoot), 'ca');
}

/**
 * Writes a generated root CA to `<projectRoot>/.stenod/ca/`:
 *   - `rootCA.pem` — the certificate (safe to install into a trust store or share).
 *   - `rootCA-key.pem` — the private key, restricted to owner-only (`0o600`)
 *     on Linux/Mac. This is the crown jewel of the whole network-capture
 *     tier: anyone who reads it could mint certificates trusted by this
 *     machine. `chmod` is skipped on `win32`, where POSIX permission bits
 *     don't apply and this tier is out of scope per SSOT §9 anyway.
 *
 * Creates `.stenod/ca/` (and `.stenod/`, via `stenoDir()`) if absent.
 */
export function persistRootCa(projectRoot: string, ca: GeneratedRootCa): PersistedRootCa {
  const dir = caDir(projectRoot);
  mkdirSync(dir, { recursive: true });

  const certPath = join(dir, 'rootCA.pem');
  const keyPath = join(dir, 'rootCA-key.pem');

  writeFileSync(certPath, ca.certPem, 'utf8');
  writeFileSync(keyPath, ca.keyPem, 'utf8');

  if (process.platform !== 'win32') {
    chmodSync(keyPath, 0o600);
  }

  return { certPath, keyPath };
}
