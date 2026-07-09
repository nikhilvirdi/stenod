/**
 * Phase 5.1 — node-pty Shell Wrapper Tests
 *
 * SSOT §6.1 / WORKPLAN Phase 5.1 "Done when" checklist:
 *   [x] A wrapped shell correctly relays stdin/stdout to the real terminal unmodified
 */

import { describe, it, expect, vi } from 'vitest';
import { TerminalWrapper } from './terminal.js';
import * as os from 'node:os';

describe('Phase 5.1 — node-pty Shell Wrapper', () => {
  // PTY execution is OS-dependent. The SSOT explicitly states Windows is out of scope.
  // We skip these tests on Windows rather than failing the suite.
  const isWindows = os.platform() === 'win32';

  it('spawns a process and relays stdout', async () => {
    if (isWindows) return;

    const onData = vi.fn();
    const onExit = vi.fn();

    new TerminalWrapper({
      shell: 'sh',
      args: ['-c', 'echo "hello stenod"'],
      onData,
      onExit,
    });

    // Wait for the exit event
    await new Promise<void>((resolve) => {
      onExit.mockImplementation(() => {
        resolve();
      });
    });

    // Verify onExit was called with success (0)
    expect(onExit).toHaveBeenCalledWith(0, expect.anything());

    // Verify onData received the output.
    // node-pty often appends \r\n, so we join all chunks and check containment.
    const calls = onData.mock.calls.map((call) => call[0]).join('');
    expect(calls).toContain('hello stenod');
  });

  it('can write to stdin and receive echoed output', async () => {
    if (isWindows) return;

    const onData = vi.fn();
    const onExit = vi.fn();

    const wrapper = new TerminalWrapper({
      shell: 'sh',
      // 'cat' will echo whatever it receives on stdin until EOF
      args: ['-c', 'cat'],
      onData,
      onExit,
    });

    // Write some input
    wrapper.write('input test\n');
    
    // Give it a brief moment to process and echo
    await new Promise((r) => setTimeout(r, 100));
    
    // Send EOF (Ctrl+D) to close stdin so `cat` exits cleanly
    wrapper.write('\x04');
    
    await new Promise<void>((resolve) => {
      onExit.mockImplementation(() => {
        resolve();
      });
    });

    expect(onExit).toHaveBeenCalledWith(0, expect.anything());
    
    const calls = onData.mock.calls.map((call) => call[0]).join('');
    expect(calls).toContain('input test');
  });
});
