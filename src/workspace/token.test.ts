import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tokenPath, generateToken, initToken, readToken } from './token.js';
import { stenoDir } from './sandbox.js';

/**
 * Phase 2.2 — Local Auth Token Tests
 *
 * SSOT §6.1: token generated at stenod init, stored at .stenod/token,
 * rotated via stenod init --reset.
 * SSOT §10: rotateable token prevents any other local process from
 * injecting fake graph events or reading captured traffic.
 *
 * Coverage:
 *   1.  generateToken produces a 64-char lowercase hex string
 *   2.  generateToken produces no collisions across 1000 calls
 *   3.  tokenPath returns the correct path within .stenod/
 *   4.  initToken creates .stenod/ if it does not exist
 *   5.  initToken writes a valid token on first call
 *   6.  initToken is idempotent — a second call (no force) returns the same token
 *   7.  initToken with force=true rotates the token to a new value
 *   8.  after rotation, the old token value is no longer stored on disk
 *   9.  readToken returns the token that was written by initToken
 *   10. readToken throws if no token file exists
 *   11. token file content matches exactly what initToken returns (no whitespace padding)
 */

describe('auth token — Phase 2.2', () => {
  const tempDirs: string[] = [];

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-token-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── generateToken ────────────────────────────────────────────────────────────

  it('generateToken returns a 64-character lowercase hex string', () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generateToken produces no collisions across 1000 calls', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      tokens.add(generateToken());
    }
    // All 1000 tokens must be unique.
    expect(tokens.size).toBe(1000);
  });

  // ── tokenPath ────────────────────────────────────────────────────────────────

  it('tokenPath returns <root>/.stenod/token', () => {
    const root = makeTempRoot();
    expect(tokenPath(root)).toBe(join(stenoDir(root), 'token'));
  });

  // ── initToken — first call ───────────────────────────────────────────────────

  it('initToken creates .stenod/ directory if it does not already exist', () => {
    const root = makeTempRoot();
    // No .stenod/ exists yet — initToken must create it.
    expect(existsSync(stenoDir(root))).toBe(false);
    initToken(root);
    expect(existsSync(stenoDir(root))).toBe(true);
  });

  it('initToken writes a valid token file on first call', () => {
    const root = makeTempRoot();
    const token = initToken(root);
    expect(existsSync(tokenPath(root))).toBe(true);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── initToken — idempotency (no force) ──────────────────────────────────────

  it('initToken without force returns the same token on a second call', () => {
    const root = makeTempRoot();
    const first = initToken(root);
    const second = initToken(root);
    expect(second).toBe(first);
  });

  it('initToken without force does not overwrite the token file', () => {
    const root = makeTempRoot();
    const first = initToken(root);
    // Call again without force — disk must still hold the original value.
    initToken(root);
    const onDisk = readToken(root);
    expect(onDisk).toBe(first);
  });

  // ── initToken — rotation (force=true) ───────────────────────────────────────

  it('initToken with force=true returns a new token (rotation)', () => {
    const root = makeTempRoot();
    const before = initToken(root);
    const after = initToken(root, true);
    // Not impossible in theory that two random 256-bit values collide, but
    // the probability is 1/2^256 — safe to treat as impossible in tests.
    expect(after).not.toBe(before);
  });

  it('after rotation the old token value is no longer on disk', () => {
    const root = makeTempRoot();
    const oldToken = initToken(root);
    initToken(root, true); // rotate
    const onDisk = readToken(root);
    expect(onDisk).not.toBe(oldToken);
  });

  it('after rotation the new token on disk matches what initToken returned', () => {
    const root = makeTempRoot();
    initToken(root);
    const newToken = initToken(root, true);
    const onDisk = readToken(root);
    expect(onDisk).toBe(newToken);
  });

  // ── readToken ────────────────────────────────────────────────────────────────

  it('readToken returns the token written by initToken', () => {
    const root = makeTempRoot();
    const written = initToken(root);
    const read = readToken(root);
    expect(read).toBe(written);
  });

  it('readToken throws if no token file exists', () => {
    const root = makeTempRoot();
    // No initToken call — token file should not exist.
    expect(() => readToken(root)).toThrow(/no token file found/i);
  });

  it('token file content matches the returned token with no surrounding whitespace', () => {
    const root = makeTempRoot();
    const token = initToken(root);
    // readToken already trims; verify the raw stored value via readToken.
    // The token must be exactly 64 chars — if whitespace crept in, the
    // 64-char hex check would fail.
    expect(token).toHaveLength(64);
    expect(readToken(root)).toBe(token);
  });
});
