import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  stenoDir,
  pidLockPath,
  attachWorkspace,
  detachWorkspace,
  WorkspaceLockedError,
} from './sandbox.js';

/**
 * Phase 2.1 — Workspace Sandboxing Tests
 *
 * SSOT §6.1: "one daemon per resolved project root, DB at <project>/.stenod/graph.db,
 * PID lock file prevents a second daemon attaching to the same root."
 *
 * Coverage:
 *   1. stenoDir / pidLockPath path helpers
 *   2. attachWorkspace creates .stenod/ and lock file on a fresh root
 *   3. attachWorkspace resolves relative paths to absolute
 *   4. A second attach to the same root (live PID) throws WorkspaceLockedError
 *   5. A stale lock file (PID that doesn't exist) is cleaned up and attach proceeds
 *   6. A corrupt lock file (non-integer content) is treated as stale and cleaned up
 *   7. detachWorkspace removes the lock file
 *   8. detachWorkspace is a no-op when the lock file is absent
 *   9. detachWorkspace does NOT remove an existing lock that belongs to a different PID
 *  10. WorkspaceLockedError carries correct projectRoot and ownerPid properties
 */

describe('workspace sandboxing — Phase 2.1', () => {
  /** Tracks temp dirs created per test so afterEach can clean them up. */
  const tempDirs: string[] = [];

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-ws-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Path helpers ────────────────────────────────────────────────────────────

  it('stenoDir returns <root>/.stenod', () => {
    // Use resolve() to construct the expected path so this test is
    // correct on both Unix (/<root>/.stenod) and Windows (<Drive>:\<root>\.stenod).
    const root = resolve('some', 'project');
    expect(stenoDir(root)).toBe(join(root, '.stenod'));
  });

  it('pidLockPath returns <root>/.stenod/daemon.pid', () => {
    const root = resolve('some', 'project');
    expect(pidLockPath(root)).toBe(join(root, '.stenod', 'daemon.pid'));
  });

  // ── Fresh attach ────────────────────────────────────────────────────────────

  it('attachWorkspace creates .stenod/ directory on a fresh root', () => {
    const root = makeTempRoot();
    attachWorkspace(root);
    expect(existsSync(stenoDir(root))).toBe(true);
  });

  it('attachWorkspace writes this process PID to the lock file', () => {
    const root = makeTempRoot();
    attachWorkspace(root);
    const pid = parseInt(readFileSync(pidLockPath(root), 'utf8').trim(), 10);
    expect(pid).toBe(process.pid);
  });

  it('attachWorkspace resolves a relative path to an absolute path', () => {
    // Create a real temp dir, then construct a relative path that resolves to it.
    // We can't actually cd, so we use process.cwd() and a subdirectory.
    const cwd = process.cwd();
    // Create a subdirectory inside cwd for this test.
    const subDir = join(cwd, '__stenod_relative_test__');
    mkdirSync(subDir, { recursive: true });
    tempDirs.push(subDir);

    // Pass a path relative to cwd.
    const relativePath = '__stenod_relative_test__';
    const resolved = attachWorkspace(relativePath);

    // The returned value must be an absolute path.
    expect(resolved).toBe(subDir);
    expect(existsSync(stenoDir(resolved))).toBe(true);
  });

  // ── Live lock (second attach on same root) ──────────────────────────────────

  it('second attach to the same root throws WorkspaceLockedError when PID is alive', () => {
    const root = makeTempRoot();

    // First attach: this process holds the lock.
    attachWorkspace(root);

    // Second attach: the lock file contains this process's own PID, which IS alive.
    // Must throw WorkspaceLockedError.
    expect(() => attachWorkspace(root)).toThrow(WorkspaceLockedError);
  });

  it('WorkspaceLockedError message identifies the project root and owner PID', () => {
    const root = makeTempRoot();
    attachWorkspace(root);

    let caught: unknown;
    try {
      attachWorkspace(root);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WorkspaceLockedError);
    const lockedErr = caught as WorkspaceLockedError;
    expect(lockedErr.ownerPid).toBe(process.pid);
    // projectRoot in the error must match the resolved absolute root.
    expect(lockedErr.projectRoot).toBe(resolve(root));
    expect(lockedErr.message).toContain(String(process.pid));
  });

  // ── Stale lock handling ─────────────────────────────────────────────────────

  it('stale lock file with a dead PID is cleaned up and attach proceeds', () => {
    const root = makeTempRoot();

    // Pre-create the .stenod/ dir and write a lock file with a PID that
    // certainly does not exist on this system. PID 1 is always init/systemd on
    // Unix, but we want a PID that is guaranteed not to exist; use a very high
    // number that is outside the typical kernel PID range on any OS.
    //
    // The safe approach: on Linux/Mac max PID is usually 4194304; on Windows
    // it's around 4194304 as well. We'll use a number that is unreachably large
    // AND non-zero/non-negative. We can't rely on any specific PID being dead,
    // so we write the lock file with a known-nonexistent PID, then verify the
    // system treats it as stale.
    //
    // To guarantee the PID is dead, we write the lock file with PID 2147483647
    // (MAX_INT_32). On any real system this PID will not exist.
    const deadPid = 2147483647;
    mkdirSync(stenoDir(root), { recursive: true });
    writeFileSync(pidLockPath(root), String(deadPid), 'utf8');

    // Attach must NOT throw — it must detect the stale lock and clean it up.
    let resolved: string | undefined;
    expect(() => {
      resolved = attachWorkspace(root);
    }).not.toThrow();

    // Lock file now belongs to this process, not the dead PID.
    const newPid = parseInt(readFileSync(pidLockPath(root), 'utf8').trim(), 10);
    expect(newPid).toBe(process.pid);
    expect(newPid).not.toBe(deadPid);
    expect(resolved).toBeDefined();
  });

  it('corrupt lock file (non-integer content) is treated as stale and cleaned up', () => {
    const root = makeTempRoot();
    mkdirSync(stenoDir(root), { recursive: true });
    writeFileSync(pidLockPath(root), 'not-a-pid', 'utf8');

    // Must not throw; must clean up and proceed.
    expect(() => attachWorkspace(root)).not.toThrow();

    const newPid = parseInt(readFileSync(pidLockPath(root), 'utf8').trim(), 10);
    expect(newPid).toBe(process.pid);
  });

  // ── detachWorkspace ─────────────────────────────────────────────────────────

  it('detachWorkspace removes the lock file', () => {
    const root = makeTempRoot();
    attachWorkspace(root);
    expect(existsSync(pidLockPath(root))).toBe(true);

    detachWorkspace(root);
    expect(existsSync(pidLockPath(root))).toBe(false);
  });

  it('detachWorkspace is a no-op when the lock file is absent', () => {
    const root = makeTempRoot();
    mkdirSync(stenoDir(root), { recursive: true });
    // No lock file written.
    expect(() => detachWorkspace(root)).not.toThrow();
  });

  it('detachWorkspace does NOT remove a lock file that belongs to a different PID', () => {
    const root = makeTempRoot();
    mkdirSync(stenoDir(root), { recursive: true });

    // Write a lock file with a different PID (use 1 — always exists on Unix,
    // but for this test we only care that it's != process.pid).
    const otherPid = process.pid + 1;
    writeFileSync(pidLockPath(root), String(otherPid), 'utf8');

    // detachWorkspace should leave this file alone because it's not ours.
    detachWorkspace(root);
    expect(existsSync(pidLockPath(root))).toBe(true);
    const pidInFile = parseInt(readFileSync(pidLockPath(root), 'utf8').trim(), 10);
    expect(pidInFile).toBe(otherPid);
  });

  // ── .stenod/ directory preservation ─────────────────────────────────────────

  it('detachWorkspace does NOT remove the .stenod/ directory itself', () => {
    const root = makeTempRoot();
    attachWorkspace(root);
    detachWorkspace(root);
    // .stenod/ must still exist for the DB and future daemon attaches.
    expect(existsSync(stenoDir(root))).toBe(true);
  });
});
