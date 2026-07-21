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
  'DECISION',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_STATUSES = ['ACTIVE', 'REJECTED', 'SUPERSEDED'] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * Phase 16.1 addition. Populated only on `DECISION` nodes; governs where a
 * decision sits on the scoreboard (ARCHITECTURE.md §7.2). Distinct from
 * `status`, which governs whether a node is live in the graph at all.
 */
export const NODE_RESOLUTIONS = ['SETTLED', 'REJECTED', 'OPEN'] as const;

export type NodeResolution = (typeof NODE_RESOLUTIONS)[number];

/**
 * Creates the graph_nodes table.
 *
 * Schema (exact, per SSOT §6.2 / workplan Phase 1.2, extended by Phase 16.1):
 *
 *   id                TEXT PRIMARY KEY        — SHA-256 of content
 *   event_id          INTEGER NOT NULL        — monotonic, WAL crash recovery ordering
 *   type              TEXT NOT NULL           — CHECK enforces NodeType enum
 *   content           TEXT NOT NULL           — redacted payload
 *   fsm_state         TEXT NOT NULL           — CHECK enforces FsmState enum
 *   constraint_key    TEXT                    — nullable; LWW key for CONSTRAINT nodes only
 *   status            TEXT NOT NULL           — CHECK enforces NodeStatus enum
 *   source_file       TEXT                    — nullable
 *   created_at        INTEGER NOT NULL        — epoch ms
 *   resolution        TEXT                    — nullable; CHECK enforces NodeResolution enum;
 *                                                populated only on DECISION nodes
 *   resolution_reason TEXT                    — nullable; required whenever
 *                                                resolution = REJECTED, enforced at the
 *                                                application layer (see insertDecisionNode)
 *
 * Do NOT create graph_edges or manifest_log here — those are separate phases.
 */
export function createGraphNodesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id                TEXT    NOT NULL PRIMARY KEY,
      event_id          INTEGER NOT NULL,
      type              TEXT    NOT NULL CHECK (type IN ('FILE_STATE', 'TERMINAL_ERROR', 'TERMINAL_SUCCESS', 'PROVIDER_CAPTURE', 'CONSTRAINT', 'DECISION')),
      content           TEXT    NOT NULL,
      fsm_state         TEXT    NOT NULL CHECK (fsm_state IN ('IDE_IDLE', 'RUNTIME_ERR', 'DOC_EDIT', 'DIFF_SUBMIT', 'PROVISIONAL_PANIC')),
      constraint_key    TEXT,
      status            TEXT    NOT NULL CHECK (status IN ('ACTIVE', 'REJECTED', 'SUPERSEDED')),
      source_file       TEXT,
      created_at        INTEGER NOT NULL,
      resolution        TEXT    CHECK (resolution IN ('SETTLED', 'REJECTED', 'OPEN')),
      resolution_reason TEXT
    )
  `);
}

/** Input to insertDecisionNode — one row for the new `DECISION` node type. */
export interface DecisionNodeInput {
  id: string;
  eventId: number;
  content: string;
  fsmState: string;
  status: NodeStatus;
  resolution: NodeResolution;
  /** Required whenever `resolution` is `REJECTED`; ignored otherwise. */
  resolutionReason?: string | null;
  createdAt: number;
}

/**
 * Inserts a `DECISION` node, enforcing the one rule a nullable CHECK
 * constraint can't express on its own: `resolution_reason` must be present
 * whenever `resolution` is `REJECTED` (Phase 16.1 Build line — "enforced at
 * the application layer"). Throws before touching the database if that rule
 * is violated.
 */
export function insertDecisionNode(db: Database.Database, input: DecisionNodeInput): void {
  if (input.resolution === 'REJECTED' && !input.resolutionReason) {
    throw new Error(
      'insertDecisionNode: resolution_reason is required when resolution is REJECTED',
    );
  }

  db.prepare(
    `INSERT INTO graph_nodes
       (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at, resolution, resolution_reason)
     VALUES (?, ?, 'DECISION', ?, ?, NULL, ?, NULL, ?, ?, ?)`,
  ).run(
    input.id,
    input.eventId,
    input.content,
    input.fsmState,
    input.status,
    input.createdAt,
    input.resolution,
    input.resolutionReason ?? null,
  );
}
