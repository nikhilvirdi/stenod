/**
 * Phase 5.2 — Batching + Backpressure
 *
 * SSOT §6.1: 16ms batching, 64KB high-water mark, overflow spills to a temp
 * file, stream pauses, resumes after flush.
 *
 * This layer wraps the TerminalWrapper's output. It accumulates chunks,
 * applying backpressure to the PTY if the buffer exceeds 64KB, and flushes
 * consistently at 16ms intervals.
 */

import { mkdtempSync, createWriteStream, readFileSync, rmSync, WriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TerminalWrapper } from './terminal.js';

export interface BatcherOptions {
  terminal: TerminalWrapper;
  onBatch: (data: string) => void;
  batchIntervalMs?: number;
  highWaterMarkBytes?: number;
}

export class TerminalBatcher {
  private memoryBuffer = '';
  private currentBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private isPaused = false;
  private isFlushing = false;

  // Temp file overflow state
  private tempDir: string | null = null;
  private overflowFile: string | null = null;
  private overflowStream: WriteStream | null = null;
  private overflowActive = false;

  constructor(private options: BatcherOptions) {
    this.startTimer();
  }

  /**
   * Consumes chunks from the TerminalWrapper.
   */
  public onData(chunk: string): void {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');

    if (this.overflowActive && this.overflowStream) {
      this.overflowStream.write(chunk);
      this.currentBytes += chunkBytes;
      return;
    }

    this.memoryBuffer += chunk;
    this.currentBytes += chunkBytes;

    const hwm = this.options.highWaterMarkBytes ?? 65536; // 64KB default
    if (this.currentBytes > hwm && !this.isPaused) {
      this.isPaused = true;
      this.options.terminal.pause();
      
      this.overflowActive = true;
      this.tempDir = mkdtempSync(join(tmpdir(), 'stenod-pty-overflow-'));
      this.overflowFile = join(this.tempDir, 'overflow.bin');
      this.overflowStream = createWriteStream(this.overflowFile, { encoding: 'utf8' });
    }
  }

  private startTimer(): void {
    const interval = this.options.batchIntervalMs ?? 16;
    this.timer = setInterval(() => {
      // Intentionally not awaiting in the setInterval callback
      // to avoid unhandled rejections, flush() manages its own concurrency.
      void this.flush();
    }, interval);
    this.timer.unref?.();
  }

  /**
   * Flushes the accumulated batch (memory + overflow file) to the consumer.
   */
  public async flush(): Promise<void> {
    if (this.isFlushing || this.currentBytes === 0) return;
    this.isFlushing = true;

    // Snapshot the current batch so concurrent onData hits a fresh buffer
    const batchData = this.memoryBuffer;
    this.memoryBuffer = '';
    this.currentBytes = 0;

    const wasPaused = this.isPaused;
    const oldStream = this.overflowStream;
    const oldFile = this.overflowFile;
    const oldTempDir = this.tempDir;
    const wasOverflowing = this.overflowActive;

    // Reset overflow state for the next batch
    this.overflowActive = false;
    this.overflowStream = null;
    this.overflowFile = null;
    this.tempDir = null;

    try {
      let finalData = batchData;

      if (wasOverflowing && oldStream && oldFile) {
        await new Promise<void>((resolve, reject) => {
          oldStream.on('error', reject);
          oldStream.end(() => resolve());
        });
        
        finalData += readFileSync(oldFile, 'utf8');
        
        if (oldTempDir) {
          rmSync(oldTempDir, { recursive: true, force: true });
        }
      }

      if (finalData.length > 0) {
        this.options.onBatch(finalData);
      }
    } finally {
      if (wasPaused) {
        // Only resume if the NEW batch hasn't already overflowed during the async flush
        const hwm = this.options.highWaterMarkBytes ?? 65536;
        if (this.currentBytes <= hwm) {
          this.isPaused = false;
          this.options.terminal.resume();
        }
      }
      this.isFlushing = false;
    }
  }

  /**
   * Cleanup timer and lingering temp files.
   */
  public cleanup(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.overflowActive && this.tempDir) {
      if (this.overflowStream) {
        this.overflowStream.destroy();
      }
      rmSync(this.tempDir, { recursive: true, force: true });
    }
  }
}
