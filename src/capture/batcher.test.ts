/**
 * Phase 5.2 — Batching + Backpressure Tests
 *
 * SSOT §6.1 / WORKPLAN Phase 5.2 "Done when" checklist:
 *   [x] Output under 64KB batches correctly at ~16ms
 *   [x] Output exceeding 64KB triggers the temp-file overflow path without data loss
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalBatcher } from './batcher.js';
import type { TerminalWrapper } from './terminal.js';

describe('Phase 5.2 — Terminal Batching + Backpressure', () => {
  let mockTerminal: TerminalWrapper;
  
  beforeEach(() => {
    vi.useFakeTimers();
    mockTerminal = {
      pause: vi.fn(),
      resume: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    } as unknown as TerminalWrapper;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('batches output under 64KB at 16ms intervals', async () => {
    const onBatch = vi.fn();
    const batcher = new TerminalBatcher({
      terminal: mockTerminal,
      onBatch,
      batchIntervalMs: 16,
      highWaterMarkBytes: 65536,
    });

    // Feed a small chunk
    batcher.onData('hello ');
    batcher.onData('world');

    expect(onBatch).not.toHaveBeenCalled();
    expect(mockTerminal.pause).not.toHaveBeenCalled();

    // Advance 15ms -> shouldn't flush yet
    vi.advanceTimersByTime(15);
    expect(onBatch).not.toHaveBeenCalled();

    // Advance to 16ms -> flushes
    // Use ByTimeAsync to let the async flush() resolve without infinite setInterval loop
    await vi.advanceTimersByTimeAsync(1);
    
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch).toHaveBeenCalledWith('hello world');
    expect(mockTerminal.pause).not.toHaveBeenCalled();

    batcher.cleanup();
  });

  it('triggers temp-file overflow when exceeding 64KB and pauses stream', async () => {
    let resolveBatch: (val: string) => void;
    const batchPromise = new Promise<string>((res) => { resolveBatch = res; });
    
    const onBatch = vi.fn((data: string) => {
      resolveBatch(data);
    });

    const batcher = new TerminalBatcher({
      terminal: mockTerminal,
      onBatch,
      batchIntervalMs: 16,
      highWaterMarkBytes: 65536,
    });

    // Feed 64KB minus 1 byte
    const largeChunk = 'A'.repeat(65535);
    batcher.onData(largeChunk);

    expect(mockTerminal.pause).not.toHaveBeenCalled();

    // Feed 2 more bytes, crossing the 64KB threshold
    batcher.onData('BC');

    // Should immediately pause the terminal
    expect(mockTerminal.pause).toHaveBeenCalledTimes(1);

    // Feed even more data (this will go into the overflow file)
    batcher.onData('DEF');

    // Advance timer to trigger flush
    await vi.advanceTimersByTimeAsync(16);

    // Wait for real I/O (stream.end()) to finish
    const received = await batchPromise;

    expect(onBatch).toHaveBeenCalledTimes(1);
    
    // Assert no data loss
    expect(received.length).toBe(65535 + 2 + 3);
    expect(received.slice(-5)).toBe('BCDEF');
    expect(received[0]).toBe('A');

    // Should have resumed after flush
    expect(mockTerminal.resume).toHaveBeenCalledTimes(1);

    batcher.cleanup();
  });

  it('does not flush empty batches', async () => {
    const onBatch = vi.fn();
    const batcher = new TerminalBatcher({
      terminal: mockTerminal,
      onBatch,
      batchIntervalMs: 16,
    });

    await vi.advanceTimersByTimeAsync(16);

    expect(onBatch).not.toHaveBeenCalled();
    batcher.cleanup();
  });
});
