import { describe, it, expect } from 'vitest';
import clipboard from 'clipboardy';
import { copyManifestToClipboard } from './clipboard.js';
import type { CompiledManifest } from '../compiler/index.js';

/**
 * Phase 9.1 — Clipboard Delivery: single real OS clipboard round trip.
 *
 * Deliberately isolated from clipboard.test.ts (which mocks `clipboardy`)
 * so that exactly one test in the whole suite exercises the real,
 * unmocked OS clipboard — see clipboard.test.ts's header comment for why
 * a real round-trip test is inherently racy against ANY other clipboard
 * activity during the run (a manual copy, a concurrent test, a CI step),
 * and why that risk is deliberately minimized to a single test rather
 * than eliminated to zero: the OS clipboard is a shared global resource,
 * and no amount of care in this one test removes the possibility of an
 * external process overwriting it between write and read — only running
 * fewer real tests reduces the exposure window.
 *
 * If this test is ever observed to fail spuriously (content mismatch with
 * no code change), that is very likely exactly this race, not a
 * regression in copyManifestToClipboard — check for concurrent clipboard
 * activity before assuming otherwise.
 *
 * Skipped when `process.env.CI` is set: `clipboardy`'s Linux backend
 * (`xsel`) requires a real X11/Wayland display server, which a headless
 * CI runner doesn't have. This is an environment limitation, not a bug in
 * the code under test — the same category as `terminal.test.ts`'s
 * `isWindows` skip for Phase 5.1 (node-pty PTY execution being
 * OS-dependent and explicitly out of scope on Windows per the SSOT). The
 * test still runs for real on any local dev machine, where `CI` is unset.
 */
describe('delivery/clipboard — Phase 9.1 (real OS clipboard, single smoke test)', () => {
  const isCI = Boolean(process.env.CI);

  it('a compiled manifest copied via copyManifestToClipboard is readable back from the real system clipboard', async () => {
    if (isCI) return;

    const manifest: CompiledManifest = {
      primacyZone: [
        {
          id: 'C1',
          type: 'CONSTRAINT',
          status: 'ACTIVE',
          utilityScore: 1,
          contentPreview: 'always use TypeScript strict mode',
          tokenCost: 5,
        },
      ],
      middleZone: [
        {
          id: 'A',
          type: 'FILE_STATE',
          status: 'ACTIVE',
          utilityScore: 0.5,
          contentPreview: 'FILE_STATE in src/a.ts',
          tokenCost: 10,
        },
      ],
      recencyZone: { resumeInstruction: 'pick up where you left off' },
    };

    await copyManifestToClipboard(manifest);
    const clipboardContent = await clipboard.read();

    expect(clipboardContent).toBe(JSON.stringify(manifest));
  });
});
