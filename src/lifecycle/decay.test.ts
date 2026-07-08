import { describe, it, expect } from 'vitest';
import { recencyDecay } from './decay.js';

/**
 * Phase 3.2 — Recency Decay Function Tests
 *
 * SSOT §6.3: decay(Δt) = 1 / (1 + ln(1 + Δt_seconds))
 * Corrected formula — no singularity at Δt=0, monotonically decreasing.
 *
 * Coverage:
 *   1. decay(0) === 1 exactly (no division-by-zero)
 *   2. Monotonically decreasing for Δt > 0
 *   3. Specific known values match hand-computed expectations
 *   4. Always positive (never zero or negative)
 *   5. Negative Δt clamped to 0 (defensive, returns 1)
 *   6. Very large Δt approaches but never reaches 0
 */

describe('recency decay — Phase 3.2', () => {
  it('decay(0) === 1 exactly, no division-by-zero', () => {
    expect(recencyDecay(0)).toBe(1);
  });

  it('monotonically decreasing for Δt > 0 across a wide range', () => {
    // Test monotonicity across a range from 0 to 1,000,000 seconds (~11.5 days).
    const testPoints = [
      0, 0.001, 0.01, 0.1, 1, 5, 10, 30, 60,
      300, 600, 1800, 3600, 7200, 14400, 28800,
      86400, 172800, 604800, 1000000,
    ];

    for (let i = 1; i < testPoints.length; i++) {
      const prev = recencyDecay(testPoints[i - 1]);
      const curr = recencyDecay(testPoints[i]);
      expect(
        curr,
        `decay(${testPoints[i]}) should be < decay(${testPoints[i - 1]})`,
      ).toBeLessThan(prev);
    }
  });

  it('known values match hand-computed expectations', () => {
    // decay(0) = 1 / (1 + ln(1)) = 1 / (1 + 0) = 1
    expect(recencyDecay(0)).toBe(1);

    // decay(1) = 1 / (1 + ln(2)) ≈ 1 / 1.6931 ≈ 0.5907
    expect(recencyDecay(1)).toBeCloseTo(1 / (1 + Math.log(2)), 10);

    // decay(e-1) where e-1 ≈ 1.71828: ln(1 + (e-1)) = ln(e) = 1
    // decay(e-1) = 1 / (1 + 1) = 0.5
    const eMinus1 = Math.E - 1;
    expect(recencyDecay(eMinus1)).toBeCloseTo(0.5, 10);

    // decay(600) = 1 / (1 + ln(601)) — the anti-rot threshold from SSOT §6.3
    expect(recencyDecay(600)).toBeCloseTo(1 / (1 + Math.log(601)), 10);
  });

  it('always positive for any non-negative Δt', () => {
    const testPoints = [0, 1, 10, 100, 1000, 10000, 100000, 1e9];
    for (const dt of testPoints) {
      expect(recencyDecay(dt), `decay(${dt})`).toBeGreaterThan(0);
    }
  });

  it('negative Δt is clamped to 0 (returns 1)', () => {
    expect(recencyDecay(-1)).toBe(1);
    expect(recencyDecay(-0.001)).toBe(1);
    expect(recencyDecay(-999999)).toBe(1);
  });

  it('very large Δt approaches but never reaches 0', () => {
    // Even at 1 billion seconds (~31 years), decay is still positive.
    const veryOld = recencyDecay(1e9);
    expect(veryOld).toBeGreaterThan(0);
    expect(veryOld).toBeLessThan(0.05); // very small but not zero
  });
});
