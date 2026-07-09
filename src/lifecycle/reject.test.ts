import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase } from '../storage/connection.js';
import { runMigrations } from '../storage/migrations.js';
import { rejectSince, parseDurationToMs } from './reject.js';

/**
 * Phase 3.4 — Time-Windowed Rejection Tests
 *
 * SSOT §6.3:
 *   "Rejection: stenod reject --since 15m — time-windowed to match FSM
 *    session boundaries... A pure graph-metadata operation (status = REJECTED)"
 *
 * Coverage:
 *   1. parseDurationToMs correctly parses 's', 'm', 'h' units.
 *   2. parseDurationToMs rejects invalid formats.
 *   3. Nodes inside the window flip to REJECTED.
 *   4. Nodes outside the window are untouched.
 *   5. Nodes that are not ACTIVE are untouched even if inside the window.
 *   6. Window calculation exactly includes the cutoff boundary.
 */

describe('Time-Windowed Rejection — Phase 3.4', () => {
  describe('parseDurationToMs', () => {
    it('correctly parses seconds', () => {
      expect(parseDurationToMs('30s')).toBe(30000);
    });

    it('correctly parses minutes', () => {
      expect(parseDurationToMs('15m')).toBe(900000);
    });

    it('correctly parses hours', () => {
      expect(parseDurationToMs('2h')).toBe(7200000);
    });

    it('rejects invalid formats', () => {
      expect(() => parseDurationToMs('15')).toThrow(/Invalid duration/);
      expect(() => parseDurationToMs('m15')).toThrow(/Invalid duration/);
      expect(() => parseDurationToMs('15d')).toThrow(/Invalid duration/);
      expect(() => parseDurationToMs('abc')).toThrow(/Invalid duration/);
    });
  });

  describe('rejectSince', () => {
    let tempDir: string;
    let db: Database.Database | undefined;

    function setup(): Database.Database {
      tempDir = mkdtempSync(join(tmpdir(), 'stenod-reject-test-'));
      db = openDatabase(join(tempDir, 'graph.db'));
      runMigrations(db);
      return db;
    }

    /** Insert a FILE_STATE node with the given id, status, and created_at. */
    function insertNode(
      conn: Database.Database,
      id: string,
      status: string,
      createdAt: number,
    ): void {
      conn
        .prepare(
          `INSERT INTO graph_nodes
             (id, event_id, type, content, fsm_state, status, created_at)
           VALUES (?, ?, 'FILE_STATE', 'content', 'IDE_IDLE', ?, ?)`,
        )
        .run(id, 1, status, createdAt);
    }

    afterEach(() => {
      if (db) {
        db.close();
        db = undefined;
      }
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('flips nodes inside the window to REJECTED and leaves outside untouched', () => {
      const conn = setup();
      const now = 1000000; // Mock current time

      // 15m window = 900,000 ms. Cutoff is 100,000.
      
      // Node A: at 50,000 (outside window, too old)
      insertNode(conn, 'nodeA', 'ACTIVE', 50000);
      
      // Node B: at 150,000 (inside window)
      insertNode(conn, 'nodeB', 'ACTIVE', 150000);
      
      // Node C: at 500,000 (inside window)
      insertNode(conn, 'nodeC', 'ACTIVE', 500000);

      const rejectedCount = rejectSince(conn, '15m', now);

      expect(rejectedCount).toBe(2);

      // Verify DB state
      const getNodeStatus = (id: string) =>
        (
          conn
            .prepare('SELECT status FROM graph_nodes WHERE id = ?')
            .get(id) as { status: string }
        ).status;

      expect(getNodeStatus('nodeA')).toBe('ACTIVE'); // Untouched
      expect(getNodeStatus('nodeB')).toBe('REJECTED'); // Flipped
      expect(getNodeStatus('nodeC')).toBe('REJECTED'); // Flipped
    });

    it('does not touch non-ACTIVE nodes even if inside the window', () => {
      const conn = setup();
      const now = 1000000;

      // Inside window, but already SUPERSEDED
      insertNode(conn, 'nodeA', 'SUPERSEDED', 500000);
      
      // Inside window, but already REJECTED
      insertNode(conn, 'nodeB', 'REJECTED', 500000);

      const rejectedCount = rejectSince(conn, '15m', now);

      expect(rejectedCount).toBe(0);

      const getNodeStatus = (id: string) =>
        (
          conn
            .prepare('SELECT status FROM graph_nodes WHERE id = ?')
            .get(id) as { status: string }
        ).status;

      expect(getNodeStatus('nodeA')).toBe('SUPERSEDED');
      expect(getNodeStatus('nodeB')).toBe('REJECTED');
    });

    it('includes nodes exactly on the cutoff boundary', () => {
      const conn = setup();
      const now = 1000000;

      // 15m window = 900,000 ms. Cutoff is 100,000.
      insertNode(conn, 'nodeOnBoundary', 'ACTIVE', 100000);
      insertNode(conn, 'nodeJustBefore', 'ACTIVE', 99999);

      const rejectedCount = rejectSince(conn, '15m', now);

      expect(rejectedCount).toBe(1);

      const getNodeStatus = (id: string) =>
        (
          conn
            .prepare('SELECT status FROM graph_nodes WHERE id = ?')
            .get(id) as { status: string }
        ).status;

      expect(getNodeStatus('nodeOnBoundary')).toBe('REJECTED');
      expect(getNodeStatus('nodeJustBefore')).toBe('ACTIVE');
    });
  });
});
