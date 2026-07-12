import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stenodInit } from '../daemon/init.js';
import { startDaemon, stopDaemon } from '../daemon/lifecycle.js';
import type { DaemonHandle } from '../daemon/lifecycle.js';
import { attachTerminalSession } from './attach.js';

/**
 * Phase 7.5 — `stenod attach` (Client-Side Terminal Bridge) Tests
 *
 * SSOT §9 / Phase 5.1: node-pty is Unix/Mac only. Gated the same way
 * `capture/terminal-state.test.ts`'s own real-PTY tests already are — an
 * early `if (isWindows) return;`, not a skip, matching precedent exactly.
 *
 * Coverage:
 *   1. a real command run through attachTerminalSession(), against a real
 *      running daemon (startDaemon()), produces a real TERMINAL_SUCCESS row
 *      with the real exit code and content, and the client's `closed`
 *      promise resolves with that same exit code
 *   2. a non-zero exit code produces TERMINAL_ERROR
 *   3. onData is called with the command's real live output
 *   4. attaching when no daemon is running fails cleanly (a thrown error,
 *      not a hang) — the daemon's real enforcement of a *wrong* token
 *      (as opposed to *no reachable* daemon) is covered in
 *      daemon/lifecycle.test.ts's Phase 7.5 section, via a raw socket
 *      connection to the real running daemon's IPC server — a wrong-token
 *      test here would be self-defeating, since attachTerminalSession()
 *      reads the token from the same on-disk file the daemon itself reads
 */
describe('cli/attach — Phase 7.5', () => {
  const isWindows = os.platform() === 'win32';
  const tempDirs: string[] = [];
  const handles: DaemonHandle[] = [];

  function makeInitializedRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stenod-attach-test-'));
    tempDirs.push(dir);
    const result = stenodInit(dir, { reset: false });
    return result.projectRoot;
  }

  afterEach(async () => {
    await Promise.all(handles.map((h) => stopDaemon(h).catch(() => {})));
    handles.length = 0;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a real passing command through the bridge produces a TERMINAL_SUCCESS row and resolves closed with exit code 0', async () => {
    if (isWindows) return;

    const root = makeInitializedRoot();
    const handle = await startDaemon(root);
    handles.push(handle);

    const chunks: string[] = [];
    const session = await attachTerminalSession(root, {
      shell: 'sh',
      args: ['-c', 'echo "bridged output"'],
      onData: (chunk) => chunks.push(chunk),
    });

    const result = await session.closed;
    expect(result.exitCode).toBe(0);

    const row = handle.db
      .prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_SUCCESS'")
      .get() as { content: string; fsm_state: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.content).toContain('bridged output');

    expect(chunks.join('')).toContain('bridged output');
  });

  it('a real failing command through the bridge produces a TERMINAL_ERROR row and resolves closed with the real exit code', async () => {
    if (isWindows) return;

    const root = makeInitializedRoot();
    const handle = await startDaemon(root);
    handles.push(handle);

    const session = await attachTerminalSession(root, {
      shell: 'sh',
      args: ['-c', 'echo "about to fail"; exit 7'],
    });

    const result = await session.closed;
    expect(result.exitCode).toBe(7);

    const row = handle.db
      .prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_ERROR'")
      .get() as { content: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.content).toContain('about to fail');
  });

  it('attaching when no daemon is running fails cleanly rather than hanging', async () => {
    if (isWindows) return;

    // stenodInit() only creates the workspace/token — no daemon is started,
    // so there's nothing listening on the socket path at all.
    const root = makeInitializedRoot();

    await expect(
      attachTerminalSession(root, { shell: 'sh', args: ['-c', 'echo hi'] })
    ).rejects.toThrow();
  });
});
