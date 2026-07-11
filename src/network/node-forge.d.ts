/**
 * Minimal ambient type declaration for the node-forge API surface Phase 12.1
 * actually uses.
 *
 * node-forge is the locked "certificate generation" dependency (SSOT §7 /
 * WORKPLAN.md Technology Decisions table, pinned 1.4.0) but ships no
 * TypeScript types of its own, and `@types/node-forge` is NOT on the locked
 * dependency list. Per the phase's user-approved decision, rather than
 * adding that off-list dependency, this file hand-declares only the
 * handful of functions/shapes `ca.ts` (and its test, which re-parses a
 * generated cert for structural verification) actually calls.
 *
 * Intentionally NOT a full node-forge type surface — forge.tls, forge.pkcs7,
 * forge.cipher, forge.asn1, etc. are all left undeclared. If a later phase
 * needs more of the API, extend this file; don't reach for
 * @types/node-forge (still off the locked list) or widen it speculatively.
 *
 * Shapes below were confirmed against the installed node-forge@1.4.0 at
 * runtime (Node's own `node:crypto` X509Certificate and node-forge's own
 * `certificateFromPem` round-trip), not guessed from memory.
 */
declare module 'node-forge' {
  export namespace pki {
    interface PublicKey {
      readonly n: unknown;
      readonly e: unknown;
    }

    interface PrivateKey {
      readonly n: unknown;
      readonly e: unknown;
      readonly d: unknown;
    }

    interface KeyPair {
      publicKey: PublicKey;
      privateKey: PrivateKey;
    }

    /** A single RDN component, e.g. `{ name: 'commonName', value: 'Stenod Local CA' }`. */
    interface DistinguishedNameAttribute {
      name: string;
      value: string;
    }

    interface DistinguishedName {
      attributes: DistinguishedNameAttribute[];
    }

    /** Extension input shape accepted by `Certificate#setExtensions()`. */
    interface CertificateExtensionInput {
      name: string;
      critical?: boolean;
      [option: string]: unknown;
    }

    /** Extension shape as read back from a parsed certificate's `.extensions`. */
    interface CertificateExtension {
      id: string;
      name: string;
      critical: boolean;
      [field: string]: unknown;
    }

    interface CertificateValidity {
      notBefore: Date;
      notAfter: Date;
    }

    interface Certificate {
      publicKey: PublicKey;
      serialNumber: string;
      validity: CertificateValidity;
      readonly subject: DistinguishedName;
      readonly issuer: DistinguishedName;
      readonly extensions: CertificateExtension[];
      setSubject(attrs: DistinguishedNameAttribute[]): void;
      setIssuer(attrs: DistinguishedNameAttribute[]): void;
      setExtensions(exts: CertificateExtensionInput[]): void;
      sign(privateKey: PrivateKey, md: MessageDigest): void;
    }

    export namespace rsa {
      /** The synchronous, bits-only overload — the only one this module uses. */
      function generateKeyPair(bits: number): KeyPair;
    }

    function createCertificate(): Certificate;
    function certificateToPem(cert: Certificate): string;
    function certificateFromPem(pem: string): Certificate;
    function privateKeyToPem(key: PrivateKey): string;
    function privateKeyFromPem(pem: string): PrivateKey;
  }

  /** Opaque digest handle — passed straight through to `Certificate#sign()`. */
  export interface MessageDigest {
    readonly algorithm?: string;
  }

  export namespace md {
    export namespace sha256 {
      function create(): MessageDigest;
    }
  }

  export namespace random {
    function getBytesSync(count: number): string;
  }

  export namespace util {
    function bytesToHex(bytes: string): string;
  }
}
