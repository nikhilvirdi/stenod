import { describe, it, expect } from 'vitest';
import { assembleUShapedManifest } from './u-shaped-manifest.js';
import type { PackableNode } from './greedy-packing.js';
import type { LocalImprovementResult } from './local-improvement.js';

/**
 * Phase 8.6 — U-Shaped Output Structuring Tests
 *
 * WORKPLAN "Done when" checklist:
 *   [x] Output ordering matches the three-zone structure exactly on a
 *       fixture
 *
 * Verify line: "unit test asserting zone ordering."
 */
describe('compiler/u-shaped-manifest — Phase 8.6', () => {
  function constraint(id: string): PackableNode {
    return {
      id,
      type: 'CONSTRAINT',
      status: 'ACTIVE',
      utilityScore: 1,
      contentPreview: `content for ${id}`,
      tokenCost: 5,
    };
  }

  function fileState(id: string): PackableNode {
    return {
      id,
      type: 'FILE_STATE',
      status: 'ACTIVE',
      utilityScore: 1,
      contentPreview: `content for ${id}`,
      tokenCost: 5,
    };
  }

  function packResult(included: PackableNode[]): LocalImprovementResult {
    return {
      included,
      excluded: [],
      totalTokens: included.reduce((sum, n) => sum + n.tokenCost, 0),
      swapCount: 0,
    };
  }

  it('constraints land in the primacy zone, non-constraints in the middle zone, regardless of interleaved input order', () => {
    // Deliberately interleaved, not constraints-first, to prove this is a
    // real filter, not a positional assumption about 8.4/8.5's ordering.
    const input = packResult([
      fileState('M1'),
      constraint('C1'),
      fileState('M2'),
      constraint('C2'),
      fileState('M3'),
    ]);

    const manifest = assembleUShapedManifest(input, 'resume here');

    expect(manifest.primacyZone.map((n) => n.id)).toEqual(['C1', 'C2']);
    expect(manifest.middleZone.map((n) => n.id)).toEqual(['M1', 'M2', 'M3']);
    expect(manifest.recencyZone.resumeInstruction).toBe('resume here');
  });

  it('the three zones appear in the correct U-shape order: primacy, then middle, then recency', () => {
    const input = packResult([constraint('C1'), fileState('M1')]);

    const manifest = assembleUShapedManifest(input, 'go');

    const zoneKeys = Object.keys(manifest);
    expect(zoneKeys).toEqual(['primacyZone', 'middleZone', 'recencyZone']);

    // Walking primacy then middle (the packed-node portion of the U-shape)
    // must put every CONSTRAINT node before every non-CONSTRAINT node.
    const walkedNodeTypes = [...manifest.primacyZone, ...manifest.middleZone].map((n) => n.type);
    const firstNonConstraintIdx = walkedNodeTypes.indexOf('FILE_STATE');
    const lastConstraintIdx = walkedNodeTypes.lastIndexOf('CONSTRAINT');
    expect(lastConstraintIdx).toBeLessThan(firstNonConstraintIdx);
  });

  it("preserves each zone's internal relative order from the Phase 8.5 result", () => {
    const input = packResult([
      constraint('C-second'),
      fileState('M-second'),
      constraint('C-first'),
      fileState('M-first'),
    ]);

    const manifest = assembleUShapedManifest(input, 'resume');

    // Order preserved exactly as it appeared in `included`, not re-sorted.
    expect(manifest.primacyZone.map((n) => n.id)).toEqual(['C-second', 'C-first']);
    expect(manifest.middleZone.map((n) => n.id)).toEqual(['M-second', 'M-first']);
  });

  it('a result with no constraints produces an empty primacy zone', () => {
    const input = packResult([fileState('M1'), fileState('M2')]);

    const manifest = assembleUShapedManifest(input, 'resume');

    expect(manifest.primacyZone).toEqual([]);
    expect(manifest.middleZone.map((n) => n.id)).toEqual(['M1', 'M2']);
  });

  it('a result with only constraints produces an empty middle zone', () => {
    const input = packResult([constraint('C1'), constraint('C2')]);

    const manifest = assembleUShapedManifest(input, 'resume');

    expect(manifest.primacyZone.map((n) => n.id)).toEqual(['C1', 'C2']);
    expect(manifest.middleZone).toEqual([]);
  });

  it('an empty pack result produces empty primacy and middle zones, with the resume instruction still present', () => {
    const input = packResult([]);

    const manifest = assembleUShapedManifest(input, 'nothing to pack');

    expect(manifest.primacyZone).toEqual([]);
    expect(manifest.middleZone).toEqual([]);
    expect(manifest.recencyZone.resumeInstruction).toBe('nothing to pack');
  });
});
