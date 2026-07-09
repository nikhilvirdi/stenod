/**
 * Phase 5.1 — node-pty Shell Wrapper
 *
 * SSOT §6.1: node-pty wraps the developer's shell.
 * Unix/Mac only per SSOT (Windows explicitly out of scope for now).
 *
 * This layer is responsible purely for spawning the shell and relaying
 * stdin/stdout. Batching, backpressure, and FSM signals are handled in later phases.
 */

import * as pty from 'node-pty';

export interface TerminalWrapperOptions {
  /** The shell executable to spawn (e.g. /bin/bash or /bin/zsh) */
  shell?: string;
  /** Arguments to pass to the shell */
  args?: string[];
  /** Initial columns */
  cols?: number;
  /** Initial rows */
  rows?: number;
  /** Current working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Callback invoked when data is received from the PTY stdout/stderr */
  onData: (data: string) => void;
  /** Callback invoked when the process exits */
  onExit: (exitCode: number, signal?: number) => void;
}

export class TerminalWrapper {
  private ptyProcess: pty.IPty;

  constructor(options: TerminalWrapperOptions) {
    // Respect user's shell preference, fallback to /bin/sh
    const shell = options.shell || process.env.SHELL || '/bin/sh';
    const args = options.args || [];
    
    // SSOT §6.1 specifies Unix/Mac only. The code doesn't actively crash on Windows,
    // but Windows ConPTY is explicitly out of scope for now.
    
    this.ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-color',
      cols: options.cols || 80,
      rows: options.rows || 24,
      cwd: options.cwd || process.cwd(),
      env: (options.env || process.env) as Record<string, string>,
    });

    this.ptyProcess.onData((data) => {
      options.onData(data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      options.onExit(exitCode, signal);
    });
  }

  /**
   * Write data (e.g. user keystrokes) into the PTY stdin.
   */
  public write(data: string): void {
    this.ptyProcess.write(data);
  }

  /**
   * Resize the PTY dimensions.
   */
  public resize(cols: number, rows: number): void {
    this.ptyProcess.resize(cols, rows);
  }

  /**
   * Kill the underlying process.
   */
  public kill(): void {
    this.ptyProcess.kill();
  }
}
