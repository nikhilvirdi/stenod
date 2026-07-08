import { createServer, Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { stenoDir } from './sandbox.js';
import { readToken } from './token.js';

/**
 * Phase 2.3 — IPC Scaffold + Token Enforcement
 *
 * SSOT §6.1:
 *   "IPC: Unix Domain Socket (Linux/Mac), Named Pipe (Windows)"
 *   "Security baseline: every local socket/proxy connection requires a token
 *    generated at stenod init, stored in .stenod/token."
 *
 * SSOT §7:
 *   "IPC: Unix Domain Socket (Linux/Mac), Named Pipe (Windows) —
 *    Standard local IPC, no network exposure."
 *
 * Design decisions (documented for review):
 * ------------------------------------------
 * PLATFORM SUPPORT:
 *   SSOT §9 excludes Windows ConPTY (node-pty) only. The tech stack table
 *   (§7) explicitly lists Named Pipe (Windows) as the IPC mechanism. Since
 *   the current build machine is Windows, named pipes are fully implemented
 *   here — not stubbed. Node.js's `net` module abstracts both transports;
 *   the only platform-specific code is the socket path convention (~6 lines).
 *
 * WIRE PROTOCOL (newline-delimited JSON):
 *   Client sends one auth message, then receives one response:
 *     → {"token":"<64-char-hex>"}\n
 *     ← {"ok":true}\n              (auth success — connection stays open)
 *     ← {"ok":false,"reason":"..."}\n  (auth failure — server calls socket.end())
 *
 *   Newline-delimited JSON is chosen because it:
 *     - is self-framing without a length prefix
 *     - is readable/debuggable with standard tools
 *     - is trivially extensible for future message types (Phases 4.x, 5.x)
 *
 * TOKEN READS PER-CONNECTION (not cached at server creation):
 *   readToken() is called on each incoming connection so that token rotation
 *   via `stenod init --reset` takes effect immediately — no server restart
 *   required. This is consistent with SSOT §6.1's rotation semantics.
 *
 * AUTH TIMEOUT:
 *   Connections that do not send an auth message within AUTH_TIMEOUT_MS are
 *   silently destroyed. Prevents indefinitely open unauthenticated connections
 *   that would block the daemon's resource footprint. Not a named SSOT
 *   requirement but a standard defensive measure for local IPC.
 *
 * DOES NOT: wire any filesystem capture, terminal capture, or graph-write
 * logic through the socket — that is the responsibility of Milestones 4–6.
 */

/** Milliseconds to wait for an auth message before closing the connection. */
const AUTH_TIMEOUT_MS = 5000;

/**
 * Returns the IPC transport path for a given (already-resolved) project root.
 *
 * On Windows: a named pipe path (`\\.\pipe\stenod-<16-char-hash>`).
 *   Named pipes cannot be placed inside a directory path; a short hash of
 *   the project root ensures uniqueness across multiple projects on the
 *   same machine.
 *
 * On Unix/Mac: a Unix domain socket at `<root>/.stenod/daemon.sock`.
 *   Placed inside .stenod/ for consistency with the other workspace artifacts.
 */
export function socketPath(projectRoot: string): string {
  if (process.platform === 'win32') {
    const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\stenod-${hash}`;
  }
  return join(stenoDir(projectRoot), 'daemon.sock');
}

/** Public interface returned by createIpcServer(). */
export interface IpcServer {
  /** The socket path or named pipe name this server listens on. */
  readonly path: string;
  /**
   * Start accepting connections. Resolves once the server is ready.
   * On Unix, removes a stale socket file from a previously crashed daemon
   * before binding — the equivalent of what attachWorkspace() does for the
   * PID lock file.
   */
  listen(): Promise<void>;
  /**
   * Destroy all open client sockets, then shut down the server.
   * Resolves once the server is fully closed. Safe to call multiple times.
   */
  close(): Promise<void>;
}

/**
 * Creates an IPC server for the given project root that enforces token
 * authentication on every inbound connection before allowing any further
 * interaction.
 *
 * Auth protocol (per connection):
 *   1. Client sends: `{"token":"<value>"}\n`
 *   2. Server reads the current on-disk token via readToken().
 *   3a. Token matches → server writes `{"ok":true}\n`, connection stays open.
 *   3b. Token mismatch, missing field, or malformed JSON → server writes
 *       `{"ok":false,"reason":"..."}\n` then calls socket.end().
 *
 * `projectRoot` must already be resolved to an absolute path (the value
 * returned by attachWorkspace() is the canonical input here).
 */
export function createIpcServer(projectRoot: string): IpcServer {
  const path = socketPath(projectRoot);

  // Track open sockets so close() can destroy them without waiting for
  // keep-alive connections to drain on their own.
  const openSockets = new Set<Socket>();

  const server = createServer((socket: Socket) => {
    openSockets.add(socket);

    socket.setEncoding('utf8');

    let buffer = '';
    let authenticated = false;

    // Auth handshake timeout — destroy the connection if no message arrives.
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        socket.destroy();
      }
    }, AUTH_TIMEOUT_MS);

    socket.on('data', (chunk: string) => {
      // Once authenticated, ignore further data — Phase 2.3 is auth-only.
      // Future phases will add real message dispatch here.
      if (authenticated) return;

      buffer += chunk;
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return; // wait for a complete message

      clearTimeout(authTimer);

      const line = buffer.slice(0, newlineIdx).trim();
      buffer = ''; // one auth exchange per connection

      // Parse auth message.
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        socket.end(JSON.stringify({ ok: false, reason: 'invalid message format' }) + '\n');
        return;
      }

      // Read current on-disk token. Called per-connection so rotation takes
      // effect without restarting the server.
      let storedToken: string;
      try {
        storedToken = readToken(projectRoot);
      } catch {
        socket.end(JSON.stringify({ ok: false, reason: 'server token unavailable' }) + '\n');
        return;
      }

      if (typeof msg['token'] !== 'string' || msg['token'] !== storedToken) {
        socket.end(JSON.stringify({ ok: false, reason: 'unauthorized' }) + '\n');
        return;
      }

      // Auth success.
      authenticated = true;
      socket.write(JSON.stringify({ ok: true }) + '\n');
      // Connection stays open. Real message handling arrives in later phases.
    });

    socket.on('error', () => {
      // Swallow per-socket errors — a single bad client must not crash the server.
      clearTimeout(authTimer);
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      openSockets.delete(socket);
    });
  });

  let closed = false;

  return {
    get path(): string {
      return path;
    },

    listen(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        // On Unix, a stale socket file from a previously crashed daemon would
        // prevent bind(). Remove it proactively, matching how attachWorkspace()
        // handles the stale PID lock file.
        if (process.platform !== 'win32' && existsSync(path)) {
          try {
            unlinkSync(path);
          } catch {
            /* ignore — if removal fails, listen() will surface the real error */
          }
        }

        server.once('error', reject);
        server.listen(path, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    },

    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;

      // Destroy all tracked open sockets so server.close() doesn't stall
      // waiting for keep-alive connections to drain.
      for (const socket of openSockets) {
        socket.destroy();
      }
      openSockets.clear();

      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (!err) {
            resolve();
            return;
          }
          // ERR_SERVER_NOT_RUNNING is benign — server was never started or was
          // already closed.
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ERR_SERVER_NOT_RUNNING') {
            resolve();
          } else {
            reject(err);
          }
        });
      });
    },
  };
}
