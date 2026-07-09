import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pidLockPath } from '../workspace/sandbox.js';
import { stenodInit } from './init.js';

/**
 * Phase 7.1 — `stenod init` Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Running init on a fresh directory produces `.stenod/`, token file,
 *       and a valid service unit file
 *
 * Coverage:
 *   1. Fresh-directory init on Linux produces .stenod/, a token file, and a
 *      syntactically valid systemd user unit (structural + content checks).
 *   2. Fresh-directory init on Mac produces .stenod/, a token file, and a
 *      syntactically valid, well-formed launchd plist (balanced XML tags +
 *      content checks), including correct XML-escaping of special
 *      characters in the project root.
 *   3. An unsupported platform (e.g. Windows) still produces .stenod/ and
 *      the token, but no service unit artifact.
 *   4. Token is idempotent across repeated init calls unless `reset: true`.
 *   5. init does not leave a dangling PID lock file behind (see init.ts's
 *      documented attach+detach design decision). Relative-path resolution
 *      itself is already covered by Phase 2.1's own test suite, since
 *      stenodInit() delegates entirely to attachWorkspace() for that.
 */
describe('daemon/init — Phase 7.1', () => {
  const tempDirs: string[] = [];

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-init-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Linux: systemd user unit ────────────────────────────────────────────

  it('on Linux, produces .stenod/, a token file, and a syntactically valid systemd unit', () => {
    const root = makeTempRoot();

    const result = stenodInit(root, { platform: 'linux' });

    expect(existsSync(result.stenoDir)).toBe(true);
    expect(existsSync(result.tokenPath)).toBe(true);
    expect(readFileSync(result.tokenPath, 'utf8').trim()).toBe(result.token);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);

    expect(result.serviceUnitPath).toBe(join(result.stenoDir, 'stenod.service'));
    expect(existsSync(result.serviceUnitPath!)).toBe(true);
    const content = readFileSync(result.serviceUnitPath!, 'utf8');
    expect(content).toBe(result.serviceUnitContent);

    // Structural INI validity: three sections, each in order, each
    // non-empty/non-comment line is either a [Section] header or key=value.
    const sectionOrder = [...content.matchAll(/^\[(\w+)\]$/gm)].map((m) => m[1]);
    expect(sectionOrder).toEqual(['Unit', 'Service', 'Install']);
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      expect(trimmed).toMatch(/^\[\w+\]$|^[A-Za-z]+=.*$/);
    }

    // Content correctness: the required crash-recovery directive and the
    // project root are present.
    expect(content).toContain('Restart=on-failure');
    expect(content).toContain(`ExecStart=stenod start --project-root "${root}"`);
    expect(content).toContain(`WorkingDirectory=${root}`);
  });

  // ── Mac: launchd plist ───────────────────────────────────────────────────

  it('on Mac, produces .stenod/, a token file, and a well-formed launchd plist', () => {
    const root = makeTempRoot();

    const result = stenodInit(root, { platform: 'darwin' });

    expect(existsSync(result.stenoDir)).toBe(true);
    expect(existsSync(result.tokenPath)).toBe(true);

    expect(result.serviceUnitPath).toBe(join(result.stenoDir, 'com.stenod.daemon.plist'));
    expect(existsSync(result.serviceUnitPath!)).toBe(true);
    const content = readFileSync(result.serviceUnitPath!, 'utf8');
    expect(content).toBe(result.serviceUnitContent);

    expect(content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(content).toContain('<!DOCTYPE plist PUBLIC');
    expect(content).toContain('<key>Label</key>');
    expect(content).toContain('<string>com.stenod.daemon</string>');
    // launchd's equivalent of Restart=on-failure.
    expect(content).toContain('<key>SuccessfulExit</key>');
    expect(content).toContain('<false/>');
    expect(content).toContain(root);

    // Well-formedness: every opening tag has a matching closing tag, in a
    // properly nested order (a minimal balanced-tags check — no full XML
    // parser is in this project's locked dependencies).
    const tags = [...content.matchAll(/<\/?([a-zA-Z][\w-]*)(?:\s+[^>]*?)?\/?>/g)];
    const stack: string[] = [];
    for (const match of tags) {
      const [full, name] = match;
      if (full.startsWith('</')) {
        expect(stack.pop()).toBe(name);
      } else if (!full.endsWith('/>')) {
        stack.push(name);
      }
      // self-closing tags (e.g. <false/>) never push.
    }
    expect(stack).toEqual([]);
  });

  it('escapes XML-special characters in the project root path within the plist', () => {
    const base = makeTempRoot();
    const root = join(base, 'a&b');

    const result = stenodInit(root, { platform: 'darwin' });
    const content = result.serviceUnitContent!;

    expect(content).not.toContain('a&b<');
    expect(content).toContain('a&amp;b');
  });

  // ── Unsupported platform ─────────────────────────────────────────────────

  it('on an unsupported platform (e.g. win32), still creates .stenod/ and the token, but no service unit', () => {
    const root = makeTempRoot();

    const result = stenodInit(root, { platform: 'win32' });

    expect(existsSync(result.stenoDir)).toBe(true);
    expect(existsSync(result.tokenPath)).toBe(true);
    expect(result.serviceUnitPath).toBeUndefined();
    expect(result.serviceUnitContent).toBeUndefined();
  });

  // ── Token behavior ────────────────────────────────────────────────────────

  it('re-running init without reset returns the same token (idempotent)', () => {
    const root = makeTempRoot();

    const first = stenodInit(root, { platform: 'linux' });
    const second = stenodInit(root, { platform: 'linux' });

    expect(second.token).toBe(first.token);
  });

  it('re-running init with reset: true rotates the token', () => {
    const root = makeTempRoot();

    const first = stenodInit(root, { platform: 'linux' });
    const second = stenodInit(root, { platform: 'linux', reset: true });

    expect(second.token).not.toBe(first.token);
    expect(readFileSync(second.tokenPath, 'utf8').trim()).toBe(second.token);
  });

  // ── No dangling PID lock ─────────────────────────────────────────────────

  it('does not leave a dangling PID lock file behind after init', () => {
    const root = makeTempRoot();

    const result = stenodInit(root, { platform: 'linux' });

    expect(existsSync(pidLockPath(result.projectRoot))).toBe(false);
  });
});
