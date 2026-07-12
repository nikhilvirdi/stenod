import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { socketPath } from '../workspace/ipc.js';
import { readToken } from '../workspace/token.js';
import { TerminalWrapper } from '../capture/terminal.js';
import { TerminalBatcher } from '../capture/batcher.js';
import type { TerminalWrapperOptions } from '../capture/terminal.js';

/**
 * Phase 7.5 — `stenod attach`: Client-Side Terminal Bridge
 *
 * SSOT §6.1/§5: this is the "thin client component that runs in the user's
 * actual shell" the Build line describes — the answer to "how does a user's
 * actual interactive shell get wrapped" (design proposal Q1, confirmed):
 * this process (not the backgrounded daemon, which has no TTY) spawns the
 * PTY, because `node-pty` forks a genuinely new pseudo-terminal — it cannot
 * attach to a shell the user already has open elsewhere (confirmed against
 * `node-pty`'s real type definitions before this design was proposed).
 *
 * Reuses `TerminalWrapper` (Phase 5.1) and `TerminalBatcher` (Phase 5.2)
 * exactly as `createTerminalCapture()` (Phase 5.3-5.5) wires them
 * internally — same forward-referenced-`batcher` pattern, same
 * flush-then-report-on-exit shape — just relocated here, where a real TTY
 * exists to spawn a shell into. Zero lines of Phase 5.1/5.2/5.3-5.5's own
 * files are modified. The daemon-side counterpart is `daemon/terminal-
 * bridge.ts`, which reuses `writeTerminalNode()` (also unmodified) for the
 * actual graph write once this client reports a session's result.
 *
 * Auth reuses `readToken()` (Phase 2.2) and the exact existing auth wire
 * protocol (Phase 2.3) unmodified — this only adds one new post-auth
 * message type (`terminal-result`), via Phase 7.5's additive `onMessage`
 * hook on `createIpcServer()`.
 *
 * Known limitation (explicitly accepted, documented in WORKPLAN.md's Phase
 * 7.5 entry and SECURITY.md): Phase 5.4's live stderr-heuristic crash
 * detection does not fire for sessions bridged through this client — the
 * daemon only sees the final accumulated content once the shell exits, not
 * live batches. Only exit-code-driven TERMINAL_SUCCESS/TERMINAL_ERROR is
 * guaranteed.
 */

/** Milliseconds to wait for the daemon's auth response before giving up. */
const AUTH_RESPONSE_TIMEOUT_MS = 5000;
/** Milliseconds to wait for the daemon to acknowledge a reported terminal result. */
const ACK_TIMEOUT_MS = 5000;

export interface AttachSessionOptions {
  /** Overrides the shell to spawn — same option TerminalWrapper (Phase 5.1) already accepts. */
  shell?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  /** Called with each raw output chunk as it arrives, for live display. */
  onData?: (chunk: string) => void;
}

export interface AttachSession {
  /** Write data (e.g. user keystrokes) into the shell's stdin. */
  write(data: string): void;
  /** Resize the underlying PTY. */
  resize(cols: number, rows: number): void;
  /**
   * Resolves once the shell has exited AND the daemon has acknowledged the
   * terminal-result report — i.e. once the write has genuinely settled, not
   * merely been sent.
   */
  closed: Promise<{ exitCode: number }>;
}

/** Connects to the daemon's IPC socket and performs the existing (Phase 2.3, unmodified) auth handshake. */
function connectAndAuthenticate(path: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setEncoding('utf8');
    let buffer = '';

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('stenod attach: timed out waiting for daemon auth response'));
    }, AUTH_RESPONSE_TIMEOUT_MS);

    socket.once('connect', () => {
      socket.write(JSON.stringify({ token }) + '\n');
    });

    function onData(chunk: string): void {
      buffer += chunk;
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;
      clearTimeout(timer);
      socket.removeListener('data', onData);

      const line = buffer.slice(0, newlineIdx);
      buffer = '';

      let msg: { ok?: boolean; reason?: string };
      try {
        msg = JSON.parse(line) as { ok?: boolean; reason?: string };
      } catch {
        socket.destroy();
        reject(new Error('stenod attach: malformed auth response from daemon'));
        return;
      }

      if (msg.ok) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`stenod attach: authentication failed (${msg.reason ?? 'unknown reason'})`));
      }
    }
    socket.on('data', onData);

    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Sends the terminal-result report and waits for the daemon's acknowledgement. */
function reportResult(socket: Socket, content: string, exitCode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('stenod attach: timed out waiting for daemon to acknowledge terminal result'));
    }, ACK_TIMEOUT_MS);

    socket.once('data', () => {
      clearTimeout(timer);
      // Any response confirms the daemon processed the message before this
      // process exits, which is the property that matters here — the exact
      // ack payload isn't otherwise consumed.
      resolve();
    });

    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.write(JSON.stringify({ type: 'terminal-result', content, exitCode }) + '\n');
  });
}

/**
 * Connects to the daemon for `projectRoot`, authenticates, then spawns a
 * real shell locally (this process's own TTY) and relays its output via
 * `options.onData`. On shell exit, reports the accumulated content and
 * exit code to the daemon and resolves `closed` once acknowledged.
 */
export async function attachTerminalSession(
  projectRoot: string,
  options: AttachSessionOptions = {}
): Promise<AttachSession> {
  const token = readToken(projectRoot);
  const path = socketPath(projectRoot);
  const socket = await connectAndAuthenticate(path, token);

  let accumulated = '';
  let resolveClosed!: (result: { exitCode: number }) => void;
  let rejectClosed!: (err: Error) => void;
  const closed = new Promise<{ exitCode: number }>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  // Forward-referenced for the same reason terminal-state.ts's own
  // createTerminalCapture() needs it: the wrapper's onData callback must
  // feed the batcher, but the batcher's constructor needs the wrapper.
  // eslint-disable-next-line prefer-const
  let batcher: TerminalBatcher;

  const wrapperOptions: TerminalWrapperOptions = {
    shell: options.shell,
    args: options.args,
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
    onData: (chunk) => {
      batcher.onData(chunk);
      options.onData?.(chunk);
    },
    onExit: (exitCode) => {
      void (async () => {
        try {
          await batcher.flush();
          batcher.cleanup();
          await reportResult(socket, accumulated, exitCode);
          resolveClosed({ exitCode });
        } catch (err) {
          rejectClosed(err as Error);
        } finally {
          socket.end();
        }
      })();
    },
  };

  const wrapper = new TerminalWrapper(wrapperOptions);

  batcher = new TerminalBatcher({
    terminal: wrapper,
    onBatch: (data) => {
      accumulated += data;
    },
  });

  return {
    write: (data: string) => wrapper.write(data),
    resize: (cols: number, rows: number) => wrapper.resize(cols, rows),
    closed,
  };
}
