import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../storage/index.js';
import { SessionFsm } from '../lifecycle/index.js';
import { createTerminalCapture } from '../capture/terminal-state.js';
import { stenoDir } from '../workspace/sandbox.js';

/**
 * Phase 10.7 — Full End-to-End Integration Test
 *
 * WORKPLAN Build line: "one comprehensive test: init a fixture project,
 * start the daemon, simulate file saves + terminal errors + a rejection +
 * an anchor, run handoff, assert the manifest contains exactly what it
 * should given the simulated session."
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THREE REAL COMPOSITION GAPS DISCOVERED WHILE BUILDING THIS PHASE
 * (reported and confirmed with the user before writing this test; per
 * explicit decision, this test exercises what the system actually does
 * today and documents these gaps inline, rather than silently working
 * around them or fixing the phases that own them):
 *
 * GAP 1 — Constraint auto-extraction is never wired into live file saves.
 *   Phase 4.3's `extractConstraintComments()` and Phase 4.2's
 *   `createAstParser()` are fully built and tested in isolation, but
 *   `file-state.ts` (4.4) explicitly declines to call them ("this phase
 *   does not invoke the Phase 4.2 AST parser... a build-order dependency,
 *   not one this file calls into") and no later phase revisits this. A
 *   real file save containing `// VCS: constraint[key]=value` produces
 *   ONLY a FILE_STATE node with that comment as inert text. The only path
 *   that ever creates a CONSTRAINT node in this codebase is the manual
 *   `stenod anchor` CLI command (10.6). This test explicitly asserts that
 *   gap (a saved file with constraint-comment syntax does NOT produce a
 *   CONSTRAINT node) rather than assuming it away.
 *
 * GAP 2 — Nothing ever fires the FSM's COMMIT event.
 *   `FSM_EVENTS` is ERROR | SAVE | COMMIT (Phase 3.1), but SSOT §6.1
 *   explicitly excludes `.git/` from the filesystem watcher, and
 *   `writeTerminalNode()` explicitly never fires any FSM event on a zero
 *   exit code. No WORKPLAN phase (0.1-14.3) implements git-commit
 *   detection. `DIFF_SUBMIT` and `PROVISIONAL_PANIC` are therefore
 *   unreachable through real capture in the system as built — this test
 *   does not attempt to reach them (there is no real mechanism to do so).
 *
 * GAP 3 — A daemonized (backgrounded) `stenod start`'s captured PTY has no
 *   externally-reachable input channel. Phase 10.3's background-daemon
 *   spawn uses `stdio: 'ignore'`, and `createTerminalCapture()`'s returned
 *   wrapper (with its `.write()` method for injecting input) lives only in
 *   the detached child process's own memory — nothing outside that process
 *   can reach it. There is currently no IPC message type (Phase 2.3 is
 *   explicitly auth-only scaffolding) or any other bridge. This means the
 *   terminal-capture step below cannot be driven through the actual
 *   backgrounded daemon started earlier in this test; it instead opens a
 *   second, direct (non-daemonized) connection to the same DB file — via
 *   `createTerminalCapture()` directly, matching the exact precedent
 *   `daemon/lifecycle.test.ts` already uses for the same reason — to
 *   exercise the real node-pty wrapper, real exit code, and real FSM
 *   transition, while being explicit that this bypasses the daemonized
 *   CLI path Gap 3 describes. Unix/Mac only (SSOT §9 excludes Windows
 *   ConPTY) — gated the same way `daemon/lifecycle.test.ts`'s own
 *   integration test already is.
 *
 * GAP 4 — FIXED. `startDaemon()` used to always spawn a second, unreachable
 *   terminal capture, and killing it at `stop()` injected a synthetic
 *   TERMINAL_SUCCESS node (shell-prompt escape-code noise) into every real
 *   session — and that node was NOT filtered out of the compiled manifest.
 *   `daemon/lifecycle.ts`'s `startDaemon()` used to unconditionally call
 *   `createTerminalCapture(db, fsm, options.terminal ?? {}, queue)` —
 *   independent of, and in addition to, the daemonized PTY Gap 3 already
 *   describes as unreachable. With no options supplied, `terminal.ts`
 *   falls back to a real default shell (`process.env.SHELL || '/bin/sh'`)
 *   that ran for the daemon's whole lifetime with nothing able to type
 *   into it. `stopDaemon()` then called `handle.terminal.kill()`. On real
 *   Linux CI, the killed shell reported `exitCode === 0`, not a
 *   signal-death exit code, so `writeTerminalNode()` wrote a
 *   `TERMINAL_SUCCESS` row, not `TERMINAL_ERROR`. Its content was the
 *   shell's own startup/prompt output — bracketed-paste-mode escape
 *   sequences, hostname, cwd (e.g. `[?2004h...runner@runnervm...`) —
 *   captured before the process ever got a chance to run a real command.
 *   Different content than the manual step-5 error, so it wasn't deduped
 *   by the `INSERT OR IGNORE` id-collision check. Verified against real
 *   Linux CI data (a temporary diagnostic dump of `graph_nodes`, commit
 *   094fcc2, run 29110536604): the synthetic row was `event_id: 4, type:
 *   'TERMINAL_SUCCESS'`. Critically, `db-to-manifest.ts` / `greedy-
 *   packing.ts` / `local-improvement.ts` apply no type-based filtering
 *   anywhere (only `status = 'ACTIVE'`, and CONSTRAINT force-inclusion) —
 *   so with content this small, this node comfortably fit the default
 *   8000-token budget and WAS packed into the manifest alongside the real
 *   nodes on every real Unix/Mac session, not just this test.
 *   First surfaced by a red Linux CI run for commit 042d97e.
 *
 *   ROOT-CAUSE FIX: `startDaemon()` no longer spawns terminal capture at
 *   all — nothing in the system could ever route real input to it (the
 *   same root cause as Gap 3), so spawning it unconditionally only ever
 *   produced this unreachable placeholder shell. The daemon now captures
 *   filesystem events only, until a future phase builds the real
 *   mechanism Gap 3 describes for routing developer terminal input to a
 *   backgrounded daemon's capture track. This means SSOT §5's "filesystem
 *   + terminal" framing for the default tier, and Phase 7.2's "Done when"
 *   checklist line about capturing "fs+terminal events," are currently
 *   aspirational for a *running* daemon — flagged per the project's
 *   regression rule, not silently resolved; Phase 7.2's literal Verify
 *   line was always fs-only and still holds. Step 8 below now asserts the
 *   synthetic TERMINAL_SUCCESS node no longer appears, on any platform.
 *
 * ADDITIONAL NOTE — headless-CI clipboard risk (not a gap introduced by
 * this phase, but surfaced by it): `stenod handoff`'s real subprocess
 * invocation always calls the real `copyManifestToClipboard()`, with no
 * CI-safe fallback. `clipboard-live.test.ts`'s own header comment already
 * documents that `clipboardy`'s Linux backend needs a real display server
 * a headless CI runner doesn't have. `manifest_log` is written *before*
 * clipboard delivery is attempted (see `program.ts`'s `handoff` action),
 * so this test verifies the manifest via the `manifest_log` row and a
 * direct DB read — the deterministic, non-racy source of truth — and only
 * best-effort-checks the CLI's exit code, tolerating a clipboard-caused
 * non-zero exit specifically when `process.env.CI` is set.
 * ═══════════════════════════════════════════════════════════════════════
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CLI_BIN = join(REPO_ROOT, 'dist', 'cli', 'bin.js');

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], { cwd, encoding: 'utf8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

describe('Full End-to-End Integration — Phase 10.7', () => {
  const isWindows = os.platform() === 'win32';
  const isCI = Boolean(process.env.CI);
  const tempDirs: string[] = [];

  beforeAll(() => {
    // Exercise the REAL compiled CLI artifact (init/start/stop/status/
    // reject/anchor/handoff all run as genuine subprocesses below), not
    // the TS source — matching how a real user actually runs `stenod`.
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
    expect(existsSync(CLI_BIN)).toBe(true);
  }, 180_000);

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'init -> start (real cross-process daemon) -> real file save -> reject -> real terminal error -> anchor -> handoff produces exactly the expected manifest',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'stenod-e2e-'));
      tempDirs.push(root);

      try {
        // ── 1. init (Phase 7.1 / 10.2) ───────────────────────────────────
        const initResult = runCli(['init'], root);
        expect(initResult.status).toBe(0);
        expect(existsSync(stenoDir(root))).toBe(true);
        expect(existsSync(join(stenoDir(root), 'token'))).toBe(true);

        // ── 2. start (Phase 7.2 / 10.3) — real cross-process daemon ─────
        const startResult = runCli(['start'], root);
        expect(startResult.status).toBe(0);

        const daemonOutLog = join(stenoDir(root), 'daemon-out.log');
        const daemonErrLog = join(stenoDir(root), 'daemon-err.log');

        const isRunning = (): boolean => runCli(['status'], root).stdout.includes('Running: true');
        const started = await waitFor(isRunning, 10_000);
        if (!started) {
          // Captured to disk instead of `stdio: 'ignore'` specifically so a
          // failure here is debuggable from the test's own output, not
          // manual reproduction (see program.ts's `start` action comment).
          const out = existsSync(daemonOutLog) ? readFileSync(daemonOutLog, 'utf8') : '(no daemon-out.log)';
          const err = existsSync(daemonErrLog) ? readFileSync(daemonErrLog, 'utf8') : '(no daemon-err.log)';
          console.error(`Daemon failed to report Running: true.\nstdout:\n${out}\nstderr:\n${err}`);
        }
        expect(started, 'expected the background daemon to report Running: true').toBe(true);

        // The daemon's own startup message should have landed in its log
        // file — confirms the stdio-capture wiring itself is working, not
        // just that the PID lock exists. Polled rather than checked
        // immediately: console.log() output redirected to a file
        // descriptor isn't necessarily flushed synchronously, so reading
        // the log the instant "Running: true" appears can race the buffer.
        const logWritten = await waitFor(
          () => existsSync(daemonOutLog) && readFileSync(daemonOutLog, 'utf8').includes('stenod daemon started'),
          5_000
        );
        expect(logWritten, 'expected the daemon startup message to appear in daemon-out.log').toBe(true);

        // `Running: true` only means the Phase 2.1 PID lock exists — it
        // does not mean chokidar has finished its initial directory scan
        // and is actively watching for new changes yet (that scan starts
        // asynchronously, after the lock is already acquired inside
        // startDaemon()). A short settle delay avoids a race where a file
        // written immediately after "Running: true" gets absorbed into
        // chokidar's still-in-progress initial scan instead of firing a
        // real 'add' event.
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        // ── 3. real file save through the daemon's own chokidar watcher ──
        // (Phase 4.1-4.5) — the daemon that picks this up is the actual
        // backgrounded process from step 2, not an in-memory shortcut.
        const savedContent =
          "export const e2eMarker = 'FILE_STATE_E2E_MARKER';\n" +
          '// VCS: constraint[should-not-auto-create]=this must NOT become a CONSTRAINT node\n';
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src', 'e2e.ts'), savedContent, 'utf8');

        function queryDb<T>(sql: string, ...params: unknown[]): T[] {
          const db = openDatabase(join(stenoDir(root), 'graph.db'));
          try {
            return db.prepare(sql).all(...params) as T[];
          } finally {
            db.close();
          }
        }

        const fileStateFound = await waitFor(() => {
          const rows = queryDb<{ id: string }>("SELECT id FROM graph_nodes WHERE type = 'FILE_STATE'");
          return rows.length > 0;
        }, 15_000);
        expect(fileStateFound, 'expected the real daemon to write a FILE_STATE node').toBe(true);

        const fileStateRows = queryDb<{ content: string; status: string }>(
          "SELECT content, status FROM graph_nodes WHERE type = 'FILE_STATE'"
        );
        expect(fileStateRows).toHaveLength(1);
        expect(fileStateRows[0].content).toBe(savedContent);

        // GAP 1, asserted directly: the constraint-comment syntax above did
        // NOT produce a CONSTRAINT node — nothing in the live pipeline
        // parses it. (See header comment.)
        const constraintsAfterSave = queryDb<{ id: string }>(
          "SELECT id FROM graph_nodes WHERE type = 'CONSTRAINT'"
        );
        expect(constraintsAfterSave).toHaveLength(0);

        // ── 4. real rejection (Phase 3.4 / 10.5) ─────────────────────────
        // `--since <duration>` rejects nodes created WITHIN the last
        // `duration` (i.e. recent ones) — done now, before the terminal
        // error and anchor exist, so only the FILE_STATE node above is
        // "recent" at this point in time. A generous window is safe
        // precisely because of that ordering, not because of tight timing.
        const rejectResult = runCli(['reject', '--since', '1h'], root);
        expect(rejectResult.status).toBe(0);
        expect(rejectResult.stdout).toContain('Rejected 1 node');

        const fileStateStatusAfterReject = queryDb<{ status: string }>(
          "SELECT status FROM graph_nodes WHERE type = 'FILE_STATE'"
        );
        expect(fileStateStatusAfterReject[0].status).toBe('REJECTED');

        // ── 5. real terminal error (Phase 5.1-5.5) — Unix/Mac only ───────
        // GAP 3 (see header comment): driven via a direct, non-daemonized
        // createTerminalCapture() call against the same DB file, matching
        // `daemon/lifecycle.test.ts`'s own precedent for the same reason —
        // nothing can reach the backgrounded daemon's own PTY from here.
        const ERROR_MARKER = 'E2E_TERMINAL_ERROR_MARKER';
        if (!isWindows) {
          const db = openDatabase(join(stenoDir(root), 'graph.db'));
          try {
            const fsm = new SessionFsm();
            const captureClosed = await new Promise<void>((resolve) => {
              const wrapper = createTerminalCapture(db, fsm, {
                shell: 'sh',
                args: ['-c', `echo ${ERROR_MARKER} >&2; exit 7`],
              });
              wrapper.captureClosed.then(resolve);
            });
            void captureClosed;
          } finally {
            db.close();
          }
        }

        const terminalErrorRows = isWindows
          ? []
          : queryDb<{ content: string; fsm_state: string }>(
              "SELECT content, fsm_state FROM graph_nodes WHERE type = 'TERMINAL_ERROR'"
            );
        if (!isWindows) {
          expect(terminalErrorRows).toHaveLength(1);
          expect(terminalErrorRows[0].content).toContain(ERROR_MARKER);
          // IDE_IDLE (post-save state) + ERROR -> RUNTIME_ERR (Phase 3.1's
          // transition table) — a real transition, not asserted in
          // isolation.
          expect(terminalErrorRows[0].fsm_state).toBe('RUNTIME_ERR');
        }

        // ── 6. real anchor (Phase 10.6) ──────────────────────────────────
        const anchorResult = runCli(
          ['anchor', 'e2e-key=never merge without running the full E2E test'],
          root
        );
        expect(anchorResult.status).toBe(0);
        expect(anchorResult.stdout).toContain('Anchored CONSTRAINT node');

        const constraintRows = queryDb<{ content: string; constraint_key: string; fsm_state: string }>(
          "SELECT content, constraint_key, fsm_state FROM graph_nodes WHERE type = 'CONSTRAINT'"
        );
        expect(constraintRows).toHaveLength(1);
        expect(constraintRows[0].content).toBe('never merge without running the full E2E test');
        expect(constraintRows[0].constraint_key).toBe('e2e-key');
        // fsm_state derived from the most recent ACTIVE node at anchor
        // time: RUNTIME_ERR on Unix/Mac (the terminal error), IDE_IDLE on
        // Windows (no terminal step ran — the FILE_STATE node is the only
        // other ACTIVE node, but it was REJECTED, so it falls back to the
        // deriveCurrentFsmState() default).
        expect(constraintRows[0].fsm_state).toBe(isWindows ? 'IDE_IDLE' : 'RUNTIME_ERR');

        // ── 7. stop the real backgrounded daemon (Phase 7.2 / 10.3) ──────
        // Known, already-documented platform limitation (surfaced during
        // Phase 10.3, not new to this phase): Node cannot deliver a real
        // graceful SIGTERM on Windows — `process.kill(pid, 'SIGTERM')`
        // force-terminates the target immediately instead of invoking its
        // signal handler, so the daemon's own stopDaemon() cleanup (which
        // removes the PID lock file) never gets to run in time, and
        // `stenod stop` reports a timeout even though the process is
        // actually dead. On Unix/Mac (including CI) the graceful path is
        // real and asserted for real; on Windows only "the process is no
        // longer running" is asserted, not "shut down within timeout."
        const stopResult = runCli(['stop'], root);
        if (!isWindows) {
          expect(stopResult.status).toBe(0);
        }
        const stopped = await waitFor(() => !isRunning(), 10_000);
        expect(stopped, 'expected the daemon process to no longer be running').toBe(true);

        // ── 8. real handoff (Phase 8.9 -> 9.1/9.2, wired by 10.4) ────────
        const handoffResult = runCli(['handoff'], root);
        if (!isCI) {
          expect(handoffResult.status).toBe(0);
        }
        // manifest_log is written before clipboard delivery is attempted
        // (see the "headless-CI clipboard risk" note above) — the
        // deterministic source of truth for this assertion either way.

        const logRows = queryDb<{ id: string; node_ids: string; token_count: number }>(
          'SELECT id, node_ids, token_count FROM manifest_log ORDER BY created_at DESC LIMIT 1'
        );
        expect(logRows).toHaveLength(1);
        const loggedNodeIds: string[] = JSON.parse(logRows[0].node_ids);

        // GAP 4 FIXED (see header comment): `stop()` (step 7, just above)
        // no longer spawns/kills a placeholder terminal capture, so no
        // synthetic TERMINAL_SUCCESS row is written on any platform.
        // Re-queried fresh here, after stop(), to prove the fix at the
        // exact point the old bug used to fire — not just inferred from
        // source. `terminalErrorRows` from step 5 predates stop() and is
        // unaffected by it; re-queried here for the manifest-content check
        // below.
        const terminalErrorRowsAfterStop = isWindows
          ? []
          : queryDb<{ id: string }>(
              "SELECT id FROM graph_nodes WHERE type = 'TERMINAL_ERROR' AND status = 'ACTIVE'"
            );
        const terminalSuccessRowsAfterStop = queryDb<{ id: string }>(
          "SELECT id FROM graph_nodes WHERE type = 'TERMINAL_SUCCESS' AND status = 'ACTIVE'"
        );
        if (!isWindows) {
          expect(terminalErrorRowsAfterStop).toHaveLength(1);
        }
        // No synthetic TERMINAL_SUCCESS node — on Unix/Mac (where GAP 4
        // used to fire) or Windows (where the daemon never spawned a live
        // shell to begin with).
        expect(terminalSuccessRowsAfterStop).toHaveLength(0);

        // Exactly the CONSTRAINT node (primacy, force-included) plus the
        // manual TERMINAL_ERROR (middle zone) on Unix/Mac. On Windows,
        // only the CONSTRAINT node (no terminal step ran there — GAP 3).
        // REJECTED FILE_STATE is excluded, but by status, not type.
        const expectedIncluded = isWindows
          ? [constraintRows[0]]
          : [constraintRows[0], ...terminalErrorRowsAfterStop];
        expect(loggedNodeIds).toHaveLength(expectedIncluded.length);

        // Fetch full manifest content directly (independent of whether the
        // CLI's own clipboard delivery succeeded) to make the "exactly
        // what it should" assertion concrete and content-specific, not
        // just count-based.
        const allNodeRows = queryDb<{ id: string; type: string; content: string; status: string }>(
          'SELECT id, type, content, status FROM graph_nodes'
        );
        const includedRows = allNodeRows.filter((n) => loggedNodeIds.includes(n.id));
        expect(includedRows.every((n) => n.status === 'ACTIVE')).toBe(true);
        expect(includedRows.some((n) => n.type === 'CONSTRAINT')).toBe(true);
        expect(includedRows.some((n) => n.type === 'FILE_STATE')).toBe(false);
        // GAP 4 fixed: never packed into the manifest, because it's never
        // written at all anymore.
        expect(includedRows.some((n) => n.type === 'TERMINAL_SUCCESS')).toBe(false);
        if (!isWindows) {
          expect(includedRows.some((n) => n.type === 'TERMINAL_ERROR')).toBe(true);
        }
      } finally {
        // Best-effort cleanup: don't leave a real daemon process running
        // in the background if an assertion threw before step 7.
        runCli(['stop'], root);
      }
    },
    120_000
  );
});
