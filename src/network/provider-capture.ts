import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { CompletedResponse } from 'mockttp';
import { nextEventId } from '../storage/index.js';
import { redactSecrets } from '../capture/redaction.js';
import type { IngestionQueue } from '../capture/queue.js';
import type { SessionFsm, FsmState } from '../lifecycle/index.js';
import type { ProviderCaptureProxy } from './proxy.js';

/**
 * Phase 12.3 — SSE `.tee()` + `PROVIDER_CAPTURE` Node Creation
 *
 * SSOT §6.1: "SSE/streaming responses are `.tee()`'d: one stream continues
 * to the caller unmodified, the other feeds the daemon."
 * SSOT §6.2: `PROVIDER_CAPTURE` is one of `graph_nodes.type`'s five values.
 * SSOT §6.3: "`PROVIDER_CAPTURE` nodes are stored as content but do NOT
 * drive FSM transitions — transitions stay driven exclusively by terminal
 * exit codes and file saves, the two unambiguous ground-truth signals."
 *
 * THE `.tee()` MECHANISM — no bespoke stream-splitting needed:
 *
 *   Phase 12.2's `createProviderCaptureProxy()` already registers a single
 *   `forAnyRequest().thenPassThrough()` rule with no `beforeResponse`
 *   transform, so the response body mockttp forwards to the caller is
 *   byte-identical to the untouched upstream response — that IS the
 *   caller-facing branch of the tee, already built, untouched by this file.
 *
 *   mockttp separately (and passively) fires a `response` event
 *   (`CompletedResponse`) once a response completes, carrying its own
 *   decoded copy of the body (`res.body.getText()`) — independent of the
 *   bytes already streamed to the caller. That event is the daemon-facing
 *   branch this module attaches. Two independent reads of the same
 *   underlying data, exactly what "tee" describes, without needing a
 *   `stream.Readable`-level `.tee()`/`PassThrough` of our own.
 *
 * `CompletedResponse` carries only an `id` (no hostname), so this module
 * correlates `response.id` against `proxy.getCapturedRequests()` — Phase
 * 12.2's own two-layer-enforced allowlist record — to (a) discard responses
 * for non-allowlisted/plain-HTTP traffic that reached this layer, and (b)
 * recover the request's `hostname`/`url` for `source_file`. Because the
 * `request` event always fires (and is synchronously recorded) before its
 * matching `response` event, the id is guaranteed present in
 * `getCapturedRequests()` by the time `response` fires for an allowlisted
 * request.
 *
 * Capture scope: every allowlisted-provider response becomes a
 * `PROVIDER_CAPTURE` node — no `Content-Type`/SSE-specific filter. Phase
 * 12.2's allowlist already scopes traffic to provider domains; SSOT §6.1's
 * "SSE/streaming" names the motivating traffic, not a content-type gate to
 * enforce (confirmed during planning).
 */

export interface ProviderCaptureWriteResult {
  /** SHA-256 hex digest of `content` (SSOT §6.2: graph_nodes.id). */
  id: string;
  eventId: number;
  /** Snapshot of fsm.state at write time — never advanced by this write. */
  fsmState: FsmState;
  /** False when a node with this exact content hash already existed. */
  created: boolean;
}

/**
 * Writes one `PROVIDER_CAPTURE` graph_nodes row for a completed provider
 * response body.
 *
 * Non-negotiable per SSOT §6.3: this function reads `fsm.state` as a
 * snapshot and NEVER calls `fsm.apply(...)`. There is no `PROVIDER_CAPTURE`
 * FSM event (Phase 3.1's `FSM_EVENTS` is exactly `ERROR`/`SAVE`/`COMMIT`) —
 * mirrors the zero-exit-code path of `writeTerminalNode()`
 * (`../capture/terminal-state.ts`), which snapshots the FSM state for a
 * ground-truth-free signal instead of transitioning on it.
 *
 * id-collision handling matches the other capture-track writers
 * (`writeFileStateNode`, `writeTerminalNode`): `INSERT OR IGNORE`, so
 * byte-identical provider output (e.g. a deterministic canned response
 * captured twice) doesn't throw or overwrite an existing row's
 * status/fsm_state.
 */
export function writeProviderCaptureNode(
  db: Database.Database,
  fsm: SessionFsm,
  content: string,
  sourceUrl: string | null,
): ProviderCaptureWriteResult {
  const redacted = redactSecrets(content);
  const id = createHash('sha256').update(redacted).digest('hex');
  // Snapshot only — SSOT §6.3 forbids this write from driving any FSM
  // transition, so `fsm.apply(...)` must never be called here.
  const fsmState = fsm.state;
  const eventId = nextEventId(db);

  const info = db
    .prepare(
      `INSERT OR IGNORE INTO graph_nodes
         (id, event_id, type, content, fsm_state, constraint_key, status, source_file, created_at)
       VALUES (?, ?, 'PROVIDER_CAPTURE', ?, ?, NULL, 'ACTIVE', ?, ?)`,
    )
    .run(id, eventId, redacted, fsmState, sourceUrl, Date.now());

  return { id, eventId, fsmState, created: info.changes > 0 };
}

export interface ProviderCaptureAttachment {
  /**
   * Resolves once every `PROVIDER_CAPTURE` write triggered so far (whether
   * still in flight or already settled) has settled. Tests await this
   * instead of polling — mirrors `CaptureWrapper.captureClosed` from
   * `../capture/terminal-state.ts`.
   *
   * There is deliberately no `detach()`: mockttp's public `Mockttp`
   * interface (`node_modules/mockttp/dist/mockttp.d.ts`) exposes `on()` but
   * no unsubscribe method — listener removal is backed internally by a
   * private `EventEmitter` field (`mockttp-server.js`'s `this.eventEmitter`)
   * that isn't part of the locked dependency's public contract. The
   * listener's lifetime is therefore tied to the proxy's own lifetime,
   * exactly like the `request` listener Phase 12.2 already registers in
   * `proxy.ts`'s `start()` — neither is ever removed independently of
   * `proxy.stop()`.
   */
  whenIdle: () => Promise<void>;
}

/**
 * Attaches the daemon-facing branch of the tee to an already-started
 * `proxy` (Phase 12.2's `createProviderCaptureProxy()` output): for every
 * completed response whose request was allowlisted-and-captured, reads the
 * full decoded body and writes one `PROVIDER_CAPTURE` node.
 *
 * Does not touch `proxy`'s existing rule/capture registration in any way —
 * this only adds a second, independent `response` listener alongside
 * mockttp's own internal handling; the caller-facing passthrough stream is
 * untouched.
 *
 * When `queue` is supplied, writes route through
 * `queue.enqueueOverflowable(...)` — the single shared write path SSOT
 * §6.1 describes — exactly like the other capture tracks' Phase 7.2 wiring.
 * Write failures (a malformed body, a closed DB, etc.) are swallowed so one
 * bad response can't take down the daemon's capture loop, matching the
 * precedent set by `createFileStateCapture()`/`createTerminalCapture()`.
 */
export function attachProviderCapture(
  proxy: ProviderCaptureProxy,
  db: Database.Database,
  fsm: SessionFsm,
  queue?: IngestionQueue,
): ProviderCaptureAttachment {
  const pendingWrites: Promise<unknown>[] = [];

  const listener = (res: CompletedResponse): void => {
    const matched = proxy.getCapturedRequests().find((req) => req.id === res.id);
    // Not in the Phase 12.2 capture record => not an allowlisted request
    // (e.g. plain-HTTP traffic to a non-allowlisted host reached this
    // layer, per proxy.ts's own two-layer-enforcement note). Skip: this is
    // the "confirmed NOT captured" boundary from Phase 12.2, preserved here.
    if (!matched) return;

    const write = (async () => {
      const content = (await res.body.getText()) ?? '';
      if (queue) {
        await queue
          .enqueueOverflowable({ content, url: matched.url }, (item) =>
            writeProviderCaptureNode(db, fsm, item.content, item.url),
          )
          .catch(() => {});
      } else {
        writeProviderCaptureNode(db, fsm, content, matched.url);
      }
    })().catch(() => {});

    pendingWrites.push(write);
  };

  void proxy.server.on('response', listener);

  return {
    whenIdle: async () => {
      // Snapshot-and-drain: writes triggered by responses that arrive
      // *during* this await are picked up by re-entrant callers awaiting
      // again, same pattern as Promise.all over a growing array used
      // elsewhere in this codebase's capture tracks.
      await Promise.all(pendingWrites);
    },
  };
}
