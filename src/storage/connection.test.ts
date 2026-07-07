import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from './connection.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Phase 1.1 verification tests — SQLite Connection + WAL Pragmas.
 *
 * Done when:
 *   [x] Connection opens against a fresh file
 *   [x] All three pragmas confirmed active via query after open
 */

describe('storage/connection — Phase 1.1', () => {
  let tempDir: string;
  let db: Database.Database | undefined;

  // Create a fresh temp dir before each test; clean it up after.
  function freshDbPath(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'stenod-test-'));
    return join(tempDir, 'graph.db');
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

  it('opens a connection against a fresh (non-existent) file', () => {
    const path = freshDbPath();
    db = openDatabase(path);
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it('PRAGMA journal_mode returns "wal" after open', () => {
    const path = freshDbPath();
    db = openDatabase(path);
    const row = db.pragma('journal_mode', { simple: true });
    expect(row).toBe('wal');
  });

  it('PRAGMA synchronous returns 1 (NORMAL) after open', () => {
    const path = freshDbPath();
    db = openDatabase(path);
    // better-sqlite3 returns the integer code: 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
    const row = db.pragma('synchronous', { simple: true });
    expect(row).toBe(1);
  });

  it('PRAGMA cache_size returns -64000 after open', () => {
    const path = freshDbPath();
    db = openDatabase(path);
    const row = db.pragma('cache_size', { simple: true });
    expect(row).toBe(-64000);
  });

  it('PRAGMA foreign_keys returns 1 (ON) after open', () => {
    const path = freshDbPath();
    db = openDatabase(path);
    // better-sqlite3 returns 1 for ON, 0 for OFF.
    const row = db.pragma('foreign_keys', { simple: true });
    expect(row).toBe(1);
  });
});
