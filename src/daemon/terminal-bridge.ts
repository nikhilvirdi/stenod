import type Database from 'better-sqlite3';
import type { Socket } from 'node:net';
import { writeTerminalNode } from '../capture/terminal-state.js';
import type { SessionFsm } from '../lifecycle/index.js';
import type { IngestionQueue } from '../capture/queue.js';

/**
 * Phase 7.5 — Terminal Bridge: Daemon-Side Message Handler
 *
 * SSOT §6.1/§5: closes "Gap 3" (documented in `cli/e2e.test.ts` and
 * `daemon/lifecycle.ts`'s own header) — there was previously no IPC message
 * type at all for routing real terminal input/results into a backgrounded
 * daemon's capture track.
 *
 * This is the daemon side of the bridge. The client side (`cli/attach.ts`)
 * owns the actual PTY — spawned in the user's real terminal, which has a
 * real TTY, unlike this headless daemon process. This module only handles
 * what arrives over the wire once a shell session the client spawned has
 * exited: a `{type: "terminal-result", content, exitCode}` message.
 *
 * Deliberately reuses `writeTerminalNode()` (Phase 5.3/5.5) directly —
 * the exact same pure function `createTerminalCapture()` itself calls
 * internally on PTY exit — rather than `createTerminalCapture()` as a
 * whole, since that function insists on constructing its own `TerminalWrapper`
 * (i.e. spawning its own PTY), which only makes sense where a real TTY
 * exists to spawn one *for* (the client, not this daemon). Zero lines of
 * `capture/terminal.ts`, `capture/batcher.ts`, or `capture/terminal-state.ts`
 * are modified by this phase — this file only calls their already-exported,
 * already-Verified pieces.
 *
 * Wired into `createIpcServer()`'s new `onMessage` hook (Phase 7.5's
 * additive extension to `workspace/ipc.ts`) by `daemon/lifecycle.ts`'s
 * `startDaemon()`.
 */

export interface TerminalResultMessage {
  type: 'terminal-result';
  content: string;
  exitCode: number;
}

function isTerminalResultMessage(value: unknown): value is TerminalResultMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === 'terminal-result' && typeof v.content === 'string' && typeof v.exitCode === 'number';
}

/**
 * Builds the `onMessage` handler passed to `createIpcServer()`. For every
 * well-formed `terminal-result` message on an authenticated connection,
 * writes a `TERMINAL_SUCCESS`/`TERMINAL_ERROR` node via `writeTerminalNode()`
 * (routed through `queue` when supplied, matching every other capture
 * track's Phase 7.2 wiring — SSOT §6.1's "all tracks feed one serialized
 * queue"), then acknowledges the socket so the client knows the write has
 * settled before it exits.
 *
 * Any other message shape is silently ignored — matches `ipc.ts`'s own
 * "malformed post-auth message" policy: a single bad/irrelevant message
 * must not crash the connection or the daemon.
 */
export function createTerminalBridgeHandler(
  db: Database.Database,
  fsm: SessionFsm,
  queue?: IngestionQueue,
): (message: unknown, socket: Socket) => void {
  return (message: unknown, socket: Socket): void => {
    if (!isTerminalResultMessage(message)) return;

    const ack = (): void => {
      socket.write(JSON.stringify({ type: 'terminal-result-ack', written: true }) + '\n');
    };

    if (queue) {
      queue
        .enqueueOverflowable({ content: message.content, exitCode: message.exitCode }, (item) =>
          writeTerminalNode(db, fsm, item.content, item.exitCode)
        )
        .then(ack)
        .catch(() => {
          // A failed write must not crash the connection — same swallow
          // policy as every other queue.enqueueOverflowable() call site in
          // this codebase (file-state.ts, terminal-state.ts).
        });
    } else {
      writeTerminalNode(db, fsm, message.content, message.exitCode);
      ack();
    }
  };
}
