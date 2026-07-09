/**
 * Phase 5.3 — Exit-Code Signal Tests
 *
 * SSOT §6.1, §6.3 / WORKPLAN Phase 5.3 "Done when" checklist:
 *   [x] Exit 0 produces TERMINAL_SUCCESS
 *   [x] Non-zero exit produces TERMINAL_ERROR and triggers RUNTIME_ERR
 *
 * Two layers, matching the phase's Verify line ("test running a passing and
 * a failing fixture command"):
 *   1. Unit tests calling writeTerminalNode() directly against a migrated
 *      temp DB — covers type/fsm_state correctness and id-collision
 *      handling without spawning a real PTY.
 *   2. End-to-end tests using the real Phase 5.1/5.2 stack via
 *      createTerminalCapture(): a real passing command and a real failing
 *      command each produce a matching graph_nodes row.
 *
 * Also covers Phase 5.5's wiring of redactSecrets() into this same write
 * path (see redaction.test.ts for the redaction patterns themselves — this
 * file only checks that the terminal write path actually calls it, reusing
 * the same fixture-with-a-secret approach Phase 4.5 used for filesystem
 * content).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { writeTerminalNode, createTerminalCapture } from './terminal-state.js';
import { REDACTED_PLACEHOLDER } from './redaction.js';
import type { TerminalWrapper } from './terminal.js';

const isWindows = os.platform() === 'win32';

/** How long to wait (ms) for an async DB write to land before giving up. */
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

describe('capture/terminal-state — Phase 5.3', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  function migratedDb(): Database.Database {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-terminal-state-test-'));
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

  // ── writeTerminalNode: unit level ───────────────────────────────────────

  it('exit code 0 produces a TERMINAL_SUCCESS node and does not advance the FSM', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm('IDE_IDLE');

    const result = writeTerminalNode(conn, fsm, 'build succeeded\n', 0);

    expect(result.type).toBe('TERMINAL_SUCCESS');
    expect(result.fsmState).toBe('IDE_IDLE');
    expect(fsm.state).toBe('IDE_IDLE');

    const row = conn
      .prepare('SELECT * FROM graph_nodes WHERE id = ?')
      .get(result.id) as Record<string, unknown>;
    expect(row['type']).toBe('TERMINAL_SUCCESS');
    expect(row['status']).toBe('ACTIVE');
    expect(row['source_file']).toBeNull();
    expect(row['content']).toBe('build succeeded\n');
    expect(row['fsm_state']).toBe('IDE_IDLE');
  });

  it('a non-zero exit code produces a TERMINAL_ERROR node and triggers RUNTIME_ERR', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm('IDE_IDLE');

    const result = writeTerminalNode(conn, fsm, 'Error: something broke\n', 1);

    expect(result.type).toBe('TERMINAL_ERROR');
    expect(result.fsmState).toBe('RUNTIME_ERR');
    expect(fsm.state).toBe('RUNTIME_ERR');

    const row = conn
      .prepare('SELECT * FROM graph_nodes WHERE id = ?')
      .get(result.id) as Record<string, unknown>;
    expect(row['type']).toBe('TERMINAL_ERROR');
    expect(row['fsm_state']).toBe('RUNTIME_ERR');
  });

  it('an already-RUNTIME_ERR fsm stays RUNTIME_ERR on a second error (same-state no-op)', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm('RUNTIME_ERR');

    const result = writeTerminalNode(conn, fsm, 'another failure\n', 127);

    expect(result.fsmState).toBe('RUNTIME_ERR');
  });

  it('re-running with byte-identical output is a no-op write (id collision), does not throw', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm();

    const first = writeTerminalNode(conn, fsm, 'same output', 0);
    expect(first.created).toBe(true);

    const second = writeTerminalNode(conn, fsm, 'same output', 0);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const count = (
      conn.prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as { cnt: number }
    ).cnt;
    expect(count).toBe(1);
  });

  it('event_id is monotonically increasing across successive writes', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm();

    const r1 = writeTerminalNode(conn, fsm, 'aaa', 0);
    const r2 = writeTerminalNode(conn, fsm, 'bbb', 1);
    const r3 = writeTerminalNode(conn, fsm, 'ccc', 0);

    expect(r2.eventId).toBeGreaterThan(r1.eventId);
    expect(r3.eventId).toBeGreaterThan(r2.eventId);
  });

  // ── Phase 5.5: secret redaction wiring ──────────────────────────────────

  it('redacts secret-shaped terminal output before it reaches graph_nodes.content', () => {
    const conn = migratedDb();
    const fsm = new SessionFsm();
    const raw = 'export GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz\nbuild ok\n';

    const result = writeTerminalNode(conn, fsm, raw, 0);

    const row = conn.prepare('SELECT content FROM graph_nodes WHERE id = ?').get(result.id) as {
      content: string;
    };
    expect(row.content).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    expect(row.content).toContain(REDACTED_PLACEHOLDER);
    expect(row.content).toContain('build ok');
  });

  // ── End-to-end: real PTY + real DB ──────────────────────────────────────
  // SSOT §9 / Phase 5.1: node-pty is Unix/Mac only. Skip on Windows rather
  // than failing the suite, matching the precedent set by terminal.test.ts.

  it('a real passing fixture command produces a TERMINAL_SUCCESS row', async () => {
    if (isWindows) return;

    const conn = migratedDb();
    const fsm = new SessionFsm('IDE_IDLE');

    let wrapper: TerminalWrapper | undefined;
    try {
      wrapper = createTerminalCapture(conn, fsm, {
        shell: 'sh',
        args: ['-c', 'echo "all good"'],
      });

      const found = await waitFor(() => {
        const row = conn
          .prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_SUCCESS'")
          .get();
        return row !== undefined;
      }, EVENT_TIMEOUT_MS);

      expect(found, 'expected a TERMINAL_SUCCESS row').toBe(true);

      const row = conn
        .prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_SUCCESS'")
        .get() as Record<string, unknown>;
      expect(row['content']).toContain('all good');
      expect(row['fsm_state']).toBe('IDE_IDLE');
    } finally {
      wrapper?.kill();
    }
  });

  it('a real failing fixture command produces a TERMINAL_ERROR row and triggers RUNTIME_ERR', async () => {
    if (isWindows) return;

    const conn = migratedDb();
    const fsm = new SessionFsm('IDE_IDLE');

    let wrapper: TerminalWrapper | undefined;
    try {
      wrapper = createTerminalCapture(conn, fsm, {
        shell: 'sh',
        args: ['-c', 'echo "oops" 1>&2; exit 1'],
      });

      const found = await waitFor(() => {
        const row = conn.prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_ERROR'").get();
        return row !== undefined;
      }, EVENT_TIMEOUT_MS);

      expect(found, 'expected a TERMINAL_ERROR row').toBe(true);

      const row = conn
        .prepare("SELECT * FROM graph_nodes WHERE type = 'TERMINAL_ERROR'")
        .get() as Record<string, unknown>;
      expect(row['content']).toContain('oops');
      expect(row['fsm_state']).toBe('RUNTIME_ERR');
      expect(fsm.state).toBe('RUNTIME_ERR');
    } finally {
      wrapper?.kill();
    }
  });
});
