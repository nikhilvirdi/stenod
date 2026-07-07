import Database from 'better-sqlite3';

/**
 * ENUM VALUES for graph_nodes — stored here as constants so TypeScript callers
 * get the same guarantee as the DB-level CHECK constraints. Both layers must agree.
 *
 * Enum enforcement choice (Phase 1.2): CHECK constraints at the SQLite level.
 * Rationale: enforced regardless of which code path inserts data; independently
 * auditable via `.schema graph_nodes`; consistent with the system's determinism
 * principle. App-level TypeScript types are an additive layer on top, not a
 * replacement.
 */

export const NODE_TYPES = [
  'FILE_STATE',
  'TERMINAL_ERROR',
  'TERMINAL_SUCCESS',
  'PROVIDER_CAPTURE',
  'CONSTRAINT',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const FSM_STATES = [
  'IDE_IDLE',
  'RUNTIME_ERR',
  'DOC_EDIT',
  'DIFF_SUBMIT',
  'PROVISIONAL_PANIC',
] as const;

export type FsmState = (typeof FSM_STATES)[number];

export const NODE_STATUSES = ['ACTIVE', 'REJECTED', 'SUPERSEDED'] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * Creates the graph_nodes table.
 *
 * Schema (exact, per SSOT §6.2 and workplan Phase 1.2):
 *
 *   id            TEXT PRIMARY KEY        — SHA-256 of content
 *   event_id      INTEGER NOT NULL        — monotonic, WAL crash recovery ordering
 *   type          TEXT NOT NULL           — CHECK enforces NodeType enum
 *   content       TEXT NOT NULL           — redacted payload
 *   fsm_state     TEXT NOT NULL           — CHECK enforces FsmState enum
 *   constraint_key TEXT                   — nullable; LWW key for CONSTRAINT nodes only
 *   status        TEXT NOT NULL           — CHECK enforces NodeStatus enum
 *   source_file   TEXT                    — nullable
 *   created_at    INTEGER NOT NULL        — epoch ms
 *
 * Do NOT add any columns beyond this list.
 * Do NOT create graph_edges or manifest_log here — those are separate phases.
 */
export function createGraphNodesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id             TEXT    NOT NULL PRIMARY KEY,
      event_id       INTEGER NOT NULL,
      type           TEXT    NOT NULL CHECK (type IN ('FILE_STATE', 'TERMINAL_ERROR', 'TERMINAL_SUCCESS', 'PROVIDER_CAPTURE', 'CONSTRAINT')),
      content        TEXT    NOT NULL,
      fsm_state      TEXT    NOT NULL CHECK (fsm_state IN ('IDE_IDLE', 'RUNTIME_ERR', 'DOC_EDIT', 'DIFF_SUBMIT', 'PROVISIONAL_PANIC')),
      constraint_key TEXT,
      status         TEXT    NOT NULL CHECK (status IN ('ACTIVE', 'REJECTED', 'SUPERSEDED')),
      source_file    TEXT,
      created_at     INTEGER NOT NULL
    )
  `);
}
