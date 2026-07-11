import { describe, it, expect, afterEach } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as forge from 'node-forge';
import { generateRootCa, persistRootCa, caDir, ROOT_CA_COMMON_NAME } from './ca.js';

/**
 * Phase 12.1 — CA Generation Tests
 *
 * WORKPLAN "Done when" checklist item under test:
 *   [ ] CA generation produces a valid certificate
 *
 * Verification strategy: cross-check the generated PEM two independent ways
 * so a bug in either the generator's own field-setting or a misunderstanding
 * of node-forge's extension shape can't hide behind a self-consistent check:
 *   1. Node's own `node:crypto` X509Certificate (a completely separate
 *      implementation from node-forge) parses the cert and confirms it's a
 *      real, self-signed CA whose signature verifies against its own public
 *      key.
 *   2. node-forge's own `certificateFromPem` round-trip confirms the
 *      specific extension fields (basicConstraints/keyUsage/criticality)
 *      this module sets, since Node's X509Certificate does not expose a
 *      populated `.keyUsage` getter for these certs on this platform/Node
 *      version (confirmed by hand against Node's own bundled root CAs
 *      during design — not a bug specific to this generator).
 *
 * Not tested: byte-exact output. Key generation and the serial number are
 * genuinely random, and validity dates are wall-clock-derived — see ca.ts's
 * module header for why that's a deliberate, scoped exception to the
 * project's determinism guarantee, not a gap in it.
 */
describe('network/ca — Phase 12.1', () => {
  const tempDirs: string[] = [];

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-ca-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('generateRootCa()', () => {
    it('produces a self-signed, valid CA certificate (verified via node:crypto)', () => {
      const { certPem, keyPem } = generateRootCa();

      expect(certPem).toContain('-----BEGIN CERTIFICATE-----');
      expect(keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');

      const x509 = new X509Certificate(certPem);

      // Marked as a real CA, not just a self-signed leaf.
      expect(x509.ca).toBe(true);

      // Self-signed: subject and issuer are identical.
      expect(x509.subject).toBe(x509.issuer);
      expect(x509.subject).toContain(`CN=${ROOT_CA_COMMON_NAME}`);

      // The certificate's signature verifies against its own public key —
      // the actual cryptographic proof of self-signing, not just matching
      // subject/issuer strings.
      expect(x509.verify(x509.publicKey)).toBe(true);
      expect(x509.checkIssued(x509)).toBe(true);

      // Validity window: starts at-or-before now (clock-skew backdate) and
      // extends multiple years into the future.
      const now = Date.now();
      expect(new Date(x509.validFrom).getTime()).toBeLessThanOrEqual(now);
      expect(new Date(x509.validTo).getTime()).toBeGreaterThan(now + 5 * 365 * 24 * 60 * 60 * 1000);
    });

    it('sets CA-signing extensions correctly (verified via node-forge round-trip)', () => {
      const { certPem } = generateRootCa();
      const cert = forge.pki.certificateFromPem(certPem);

      const basicConstraints = cert.extensions.find((e) => e.name === 'basicConstraints');
      expect(basicConstraints).toBeDefined();
      expect(basicConstraints!.critical).toBe(true);
      expect(basicConstraints!['cA']).toBe(true);

      const keyUsage = cert.extensions.find((e) => e.name === 'keyUsage');
      expect(keyUsage).toBeDefined();
      expect(keyUsage!.critical).toBe(true);
      expect(keyUsage!['keyCertSign']).toBe(true);
      expect(keyUsage!['cRLSign']).toBe(true);

      const subjectKeyId = cert.extensions.find((e) => e.name === 'subjectKeyIdentifier');
      expect(subjectKeyId).toBeDefined();
    });

    it("produces a private key that actually corresponds to the certificate's public key", () => {
      const { certPem, keyPem } = generateRootCa();

      const cert = forge.pki.certificateFromPem(certPem);
      const privateKey = forge.pki.privateKeyFromPem(keyPem);

      // Both an RSA public/private pair share the same modulus.
      expect((privateKey as unknown as { n: { toString(): string } }).n.toString()).toBe(
        (cert.publicKey as unknown as { n: { toString(): string } }).n.toString()
      );
    });

    it('generates a fresh keypair (and thus a different cert) on every call', () => {
      const first = generateRootCa();
      const second = generateRootCa();

      expect(first.certPem).not.toBe(second.certPem);
      expect(first.keyPem).not.toBe(second.keyPem);
    });
  });

  describe('persistRootCa()', () => {
    it('writes cert + key files under .stenod/ca/ and returns their paths', () => {
      const root = makeTempRoot();
      const ca = generateRootCa();

      const result = persistRootCa(root, ca);

      expect(result.certPath).toBe(join(caDir(root), 'rootCA.pem'));
      expect(result.keyPath).toBe(join(caDir(root), 'rootCA-key.pem'));

      expect(existsSync(result.certPath)).toBe(true);
      expect(existsSync(result.keyPath)).toBe(true);
      expect(readFileSync(result.certPath, 'utf8')).toBe(ca.certPem);
      expect(readFileSync(result.keyPath, 'utf8')).toBe(ca.keyPem);
    });

    it('restricts the private key file to owner-only permissions on non-Windows platforms', () => {
      if (process.platform === 'win32') {
        // POSIX permission bits don't apply on Windows, and this tier is
        // out of scope there per SSOT §9 — nothing to assert.
        return;
      }

      const root = makeTempRoot();
      const ca = generateRootCa();
      const result = persistRootCa(root, ca);

      const mode = statSync(result.keyPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('creates .stenod/ca/ if it does not already exist', () => {
      const root = makeTempRoot();
      expect(existsSync(caDir(root))).toBe(false);

      persistRootCa(root, generateRootCa());

      expect(existsSync(caDir(root))).toBe(true);
    });
  });
});
