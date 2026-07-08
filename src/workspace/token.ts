import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stenoDir } from './sandbox.js';

/**
 * Phase 2.2 — Local Auth Token
 *
 * SSOT §6.1:
 *   "every local socket/proxy connection requires a token generated at
 *    stenod init, stored in .stenod/token, rotated via stenod init --reset."
 *
 * SSOT §10:
 *   "Auth on every local connection — a rotateable token prevents any other
 *    local process from injecting fake graph events or reading captured traffic."
 *
 * Design decisions (documented for review):
 * ------------------------------------------
 * - Token is 32 random bytes encoded as a lowercase hex string (64 chars).
 *   32 bytes = 256 bits of entropy — well above any practical brute-force
 *   threshold for a local IPC secret.
 * - hex encoding is used rather than base64 because hex is URL-safe, has no
 *   padding, and is trivially copy-paste-safe in shell scripts and config files.
 * - The token file is written with mode 0o600 (owner read/write only) via the
 *   `mode` option of writeFileSync to limit filesystem-level exposure.
 * - `stenoDir()` from Phase 2.1 is used directly — the path is not duplicated.
 *
 * Does NOT: establish IPC sockets or enforce the token on connections —
 * that is Phase 2.3.
 */

/** Number of random bytes used for the token (256 bits of entropy). */
const TOKEN_BYTE_LENGTH = 32;

/** Token file name inside .stenod/. */
const TOKEN_FILENAME = 'token';

/** Returns the absolute path of the token file for a given (already-resolved) project root. */
export function tokenPath(projectRoot: string): string {
  return join(stenoDir(projectRoot), TOKEN_FILENAME);
}

/**
 * Generates a cryptographically random token string.
 *
 * Returns a 64-character lowercase hex string (32 bytes = 256 bits of entropy).
 * Uses Node's built-in `crypto.randomBytes` — no external dependency needed.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
}

/**
 * Initialises the token for `projectRoot`:
 *   - Ensures `.stenod/` exists (idempotent — uses recursive mkdir).
 *   - If a token file already exists AND `force` is false, reads and returns
 *     the existing token without overwriting it.
 *   - If `force` is true (i.e. `stenod init --reset`), unconditionally
 *     generates a new token, overwrites the file, and returns the new value.
 *     This is the rotation path — the old token is gone and any IPC client
 *     holding the old value will be rejected by Phase 2.3's enforcement.
 *
 * `projectRoot` must already be resolved to an absolute path (the value
 * returned by `attachWorkspace()` is the canonical input here).
 *
 * Returns the active token string after the operation.
 */
export function initToken(projectRoot: string, force = false): string {
  const dir = stenoDir(projectRoot);
  const filePath = tokenPath(projectRoot);

  // Ensure .stenod/ exists before writing the token file.
  mkdirSync(dir, { recursive: true });

  if (!force && existsSync(filePath)) {
    // Not a reset — return the existing token unchanged.
    return readFileSync(filePath, 'utf8').trim();
  }

  // Generate a fresh token (either first init or explicit rotation).
  const token = generateToken();

  // Write with mode 0o600: owner read/write only.
  // On Windows, Node honours the mode flag for the initial file creation;
  // it does not map 1:1 to ACLs but does restrict the initial permission bits.
  writeFileSync(filePath, token, { encoding: 'utf8', mode: 0o600 });

  return token;
}

/**
 * Reads the current token from disk for `projectRoot`.
 *
 * Throws if the token file does not exist — callers should only invoke this
 * after a successful `initToken()` call (i.e. after `stenod init`).
 */
export function readToken(projectRoot: string): string {
  const filePath = tokenPath(projectRoot);
  if (!existsSync(filePath)) {
    throw new Error(
      `stenod: no token file found at "${filePath}". ` +
        `Run \`stenod init\` first to generate one.`
    );
  }
  return readFileSync(filePath, 'utf8').trim();
}
