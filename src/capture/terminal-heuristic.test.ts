/**
 * Phase 5.4 — Long-Running Process Stderr Heuristic Tests
 *
 * SSOT §6.1 / WORKPLAN Phase 5.4 "Done when" checklist:
 *   [x] A long-running fixture process emitting a crash-shaped stderr line
 *       produces a node tagged as heuristic-detected (distinguishable from
 *       the exit-code path)
 *
 * Two layers, matching the phase's Verify line ("test with a fixture that
 * never exits but emits a stack-trace-shaped line"):
 *   1. Unit tests for looksLikeCrash() and writeHeuristicCrashNode()
 *      against a migrated temp DB — no real PTY involved.
 *   2. An end-to-end test using the real Phase 5.1/5.2/5.3 stack via
 *      createTerminalCapture(): a fixture process that emits a crash-shaped
 *      line and then sleeps (never exits within the test) produces a
 *      heuristic-tagged TERMINAL_ERROR row, and the FSM does not advance.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { looksLikeCrash, writeHeuristicCrashNode, HEURISTIC_CRASH_TAG } from './terminal-heuristic.js';
import { createTerminalCapture } from './terminal-state.js';
import { REDACTED_PLACEHOLDER } from './redaction.js';
import type { TerminalWrapper } from './terminal.js';

const isWindows = os.platform() === 'win32';
const EVENT_TIMEOUT_MS = 3000;

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 25);
  });
}

describe('capture/terminal-heuristic — Phase 5.4', () => {
  // ── looksLikeCrash: pattern matching ────────────────────────────────────

  describe('looksLikeCrash', () => {
    it.each([
      'Error: something went wrong',
      'Traceback (most recent call last):',
      "thread 'main' panic: index out of bounds",
      'unhandled rejection: Promise rejected',
      'Unhandled promise rejection detected',
      'UNHANDLED REJECTION',
    ])('matches crash-shaped line: %s', (line) => {
      expect(looksLikeCrash(line)).toBe(true);
    });

    it.each([
      'Compiled successfully!',
      'Server listening on port 3000',
      'const errorHandler = (err) => log(err);', // "Error" not capitalized+colon-shaped
      'a titanic ship sailed on', // no crash pattern present
      '',
    ])('does not match ordinary output: %s', (line) => {
      expect(looksLikeCrash(line)).toBe(false);
    });
  });

  // ── writeHeuristicCrashNode: unit level ──────────────────────────────────

  describe('writeHeuristicCrashNode', () => {
    let tempDir: string;
    let db: Database.Database | undefined;

    function migratedDb(): Database.Database {
      tempDir = mkdtempSync(join(tmpdir(), 'stenod-terminal-heuristic-test-'));
      db = openDatabase(join(tempDir, 'graph.db'));
      runMigrations(db);
      return db;
    }

    afterEach(() => {
      if (db) {
        db.close();
        db = undefined;
      }
      if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('writes a TERMINAL_ERROR node with content tagged as heuristic-detected', () => {
      const conn = migratedDb();
      const fsm = new SessionFsm('IDE_IDLE');

      const result = writeHeuristicCrashNode(conn, fsm, 'Error: dev server crashed\n');

      expect(result.type).toBe('TERMINAL_ERROR');
      const row = conn
        .prepare('SELECT * FROM graph_nodes WHERE id = ?')
        .get(result.id) as Record<string, unknown>;
      expect(row['type']).toBe('TERMINAL_ERROR');
      expect(row['content']).toBe(`${HEURISTIC_CRASH_TAG}Error: dev server crashed\n`);
      expect((row['content'] as string).startsWith(HEURISTIC_CRASH_TAG)).toBe(true);
    });

    it('does NOT advance the FSM — fsm_state is a snapshot, fsm.state is unchanged', () => {
      const conn = migratedDb();
      const fsm = new SessionFsm('IDE_IDLE');

      const result = writeHeuristicCrashNode(conn, fsm, 'panic: runtime error');

      expect(result.fsmState).toBe('IDE_IDLE');
      expect(fsm.state).toBe('IDE_IDLE');
    });

    it('is distinguishable from a real exit-code TERMINAL_ERROR row by its content tag', () => {
      const conn = migratedDb();
      const fsm = new SessionFsm();

      writeHeuristicCrashNode(conn, fsm, 'Traceback (most recent call last): boom');

      const row = conn.prepare('SELECT content FROM graph_nodes').get() as { content: string };
      // A real exit-code TERMINAL_ERROR (Phase 5.3) would store raw command
      // output with no such prefix — this tag is what makes the two paths
      // distinguishable despite sharing the same graph_nodes.type value.
      expect(row.content.startsWith(HEURISTIC_CRASH_TAG)).toBe(true);
    });

    it('re-detecting byte-identical content is a no-op write (id collision), does not throw', () => {
      const conn = migratedDb();
      const fsm = new SessionFsm();

      const first = writeHeuristicCrashNode(conn, fsm, 'Error: same crash');
      const second = writeHeuristicCrashNode(conn, fsm, 'Error: same crash');

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);

      const count = (
        conn.prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as { cnt: number }
      ).cnt;
      expect(count).toBe(1);
    });

    it('redacts secret-shaped content before it reaches graph_nodes.content (Phase 5.5)', () => {
      const conn = migratedDb();
      const fsm = new SessionFsm();
      const raw = 'Error: request failed\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def\n';

      const result = writeHeuristicCrashNode(conn, fsm, raw);

      const row = conn.prepare('SELECT content FROM graph_nodes WHERE id = ?').get(result.id) as {
        content: string;
      };
      expect(row.content).not.toContain('eyJhbGciOiJIUzI1NiJ9.abc.def');
      expect(row.content).toContain(REDACTED_PLACEHOLDER);
      expect(row.content.startsWith(HEURISTIC_CRASH_TAG)).toBe(true);
      expect(row.content).toContain('Error: request failed');
    });
  });

  // ── End-to-end: real PTY, a fixture that never exits ────────────────────
  // SSOT §9 / Phase 5.1: node-pty is Unix/Mac only. Skip on Windows rather
  // than failing the suite, matching the precedent set by terminal.test.ts.

  describe('end-to-end: never-exiting fixture process', () => {
    let tempDir: string;
    let db: Database.Database | undefined;
    let wrapper: TerminalWrapper | undefined;

    afterEach(() => {
      wrapper?.kill();
      wrapper = undefined;
      if (db) {
        db.close();
        db = undefined;
      }
      if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('a crash-shaped line from a long-running process produces a heuristic node before the process exits, without advancing the FSM', async () => {
      if (isWindows) return;

      tempDir = mkdtempSync(join(tmpdir(), 'stenod-terminal-heuristic-e2e-'));
      db = openDatabase(join(tempDir, 'graph.db'));
      runMigrations(db);
      const fsm = new SessionFsm('IDE_IDLE');

      // Emits a crash-shaped line immediately, then sleeps well past this
      // test's timeout — simulating a dev server that has crashed internally
      // but whose host process (e.g. a supervisor) never actually exits.
      wrapper = createTerminalCapture(db, fsm, {
        shell: 'sh',
        args: ['-c', 'echo "Error: dev server crashed unexpectedly"; sleep 100'],
      });

      const conn = db;
      const found = await waitFor(() => {
        const row = conn.prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_ERROR'").get();
        return row !== undefined;
      }, EVENT_TIMEOUT_MS);

      expect(found, 'expected a heuristic TERMINAL_ERROR row before process exit').toBe(true);

      const row = conn
        .prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_ERROR'")
        .get() as Record<string, unknown>;
      expect((row['content'] as string).startsWith(HEURISTIC_CRASH_TAG)).toBe(true);
      expect(row['content']).toContain('dev server crashed unexpectedly');
      expect(row['fsm_state']).toBe('IDE_IDLE');
      expect(fsm.state).toBe('IDE_IDLE');

      // No TERMINAL_SUCCESS/exit-driven row should exist — the process is
      // still running (it's asleep, not exited) at this point in the test.
      const exitDrivenCount = (
        conn.prepare("SELECT COUNT(*) as cnt FROM graph_nodes WHERE type = 'TERMINAL_SUCCESS'").get() as {
          cnt: number;
        }
      ).cnt;
      expect(exitDrivenCount).toBe(0);
    });
  });
});
