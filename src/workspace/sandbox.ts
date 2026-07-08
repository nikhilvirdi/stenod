import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Phase 2.1 — Workspace Sandboxing
 *
 * SSOT §6.1:
 *   "Workspace sandboxing: one daemon per resolved project root,
 *    DB at <project>/.stenod/graph.db, PID lock file prevents a
 *    second daemon attaching to the same root."
 *
 * This module is responsible for:
 *   1. Resolving the project root to an absolute path.
 *   2. Creating the .stenod/ directory if absent.
 *   3. Writing a PID lock file (.stenod/daemon.pid) on attach.
 *   4. Enforcing single-daemon-per-root invariant:
 *      - If a lock file exists and the PID in it is still alive → error.
 *      - If a lock file exists but the PID is dead (stale lock) → clean up and proceed.
 *   5. Releasing the lock file on detach.
 *
 * Does NOT: generate auth tokens, open the SQLite database, or
 * establish any IPC socket — those are Phase 2.2 and 2.3 respectively.
 */

/** The resolved path of the .stenod directory for a given project root. */
export function stenoDir(projectRoot: string): string {
  return resolve(projectRoot, '.stenod');
}

/** The path of the PID lock file for a given project root. */
export function pidLockPath(projectRoot: string): string {
  return resolve(stenoDir(projectRoot), 'daemon.pid');
}

/**
 * Returns true if a process with the given PID is currently alive.
 *
 * Implementation note:
 *   `process.kill(pid, 0)` does not actually send a signal — it is the
 *   POSIX-standard way to probe whether a process exists. On Linux/Mac it
 *   returns normally if the process is alive and throws if it is not.
 *   On Windows, Node.js implements the same semantics for signal 0 via
 *   the Win32 OpenProcess API, so this works cross-platform.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = process exists but we can't signal it.
    // We treat EPERM as "alive" because the process genuinely exists —
    // we just lack permission to signal it.
    // Any other error (including ESRCH) means the process is gone.
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/**
 * Error thrown when a second daemon tries to attach to a root that already
 * has a live daemon running.
 */
export class WorkspaceLockedError extends Error {
  constructor(public readonly projectRoot: string, public readonly ownerPid: number) {
    super(
      `stenod: workspace already locked by daemon PID ${ownerPid} at "${projectRoot}". ` +
        `Run \`stenod stop\` before starting a new daemon on this root.`
    );
    this.name = 'WorkspaceLockedError';
  }
}

/**
 * Attaches to the workspace at `projectRoot`:
 *   1. Resolves `projectRoot` to an absolute path.
 *   2. Creates `.stenod/` if it does not exist.
 *   3. Checks for an existing PID lock file:
 *      - No lock file → proceed.
 *      - Lock file with alive PID → throws WorkspaceLockedError.
 *      - Lock file with dead PID (stale) → removes the stale file and proceeds.
 *   4. Writes this process's PID to the lock file.
 *
 * Returns the resolved absolute project root path.
 */
export function attachWorkspace(projectRoot: string): string {
  const resolvedRoot = resolve(projectRoot);
  const dir = stenoDir(resolvedRoot);
  const lockPath = pidLockPath(resolvedRoot);

  // Step 1: ensure .stenod/ exists.
  mkdirSync(dir, { recursive: true });

  // Step 2: check for an existing lock file.
  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const ownerPid = parseInt(raw, 10);

    if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
      // Corrupt/unreadable lock file — treat as stale and clean up.
      unlinkSync(lockPath);
    } else if (isProcessAlive(ownerPid)) {
      throw new WorkspaceLockedError(resolvedRoot, ownerPid);
    } else {
      // Stale lock: the PID no longer corresponds to a running process.
      unlinkSync(lockPath);
    }
  }

  // Step 3: write our own PID.
  writeFileSync(lockPath, String(process.pid), 'utf8');

  return resolvedRoot;
}

/**
 * Releases the PID lock file for `projectRoot`.
 *
 * Safe to call even if the lock file is absent (e.g. already cleaned up).
 * Does NOT remove the .stenod/ directory itself — other artifacts (DB, token)
 * live there and must not be deleted on a clean stop.
 */
export function detachWorkspace(projectRoot: string): void {
  const resolvedRoot = resolve(projectRoot);
  const lockPath = pidLockPath(resolvedRoot);

  if (existsSync(lockPath)) {
    try {
      const raw = readFileSync(lockPath, 'utf8').trim();
      const pid = parseInt(raw, 10);
      // Only remove the lock if it actually belongs to this process.
      // Avoids a race where a new daemon has already claimed the lock
      // and this process (shutting down) would incorrectly remove it.
      if (pid === process.pid) {
        unlinkSync(lockPath);
      }
    } catch {
      // If the file disappeared between existsSync and unlinkSync, that's fine.
    }
  }
}
