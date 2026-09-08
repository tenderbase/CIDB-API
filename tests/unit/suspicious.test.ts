import { describe, expect, it } from 'vitest';
import { evaluateSuspiciousResult } from '../../src/services/syncService.js';

const GUARDS = { minExpectedRecords: 1, maxDropRatio: 0.8 };

describe('evaluateSuspiciousResult', () => {
  it('flags zero results when history exists', () => {
    expect(evaluateSuspiciousResult(0, 247, GUARDS)).toMatch(/SUSPICIOUS_ZERO_RESULTS/);
  });

  it('flags catastrophic drops', () => {
    expect(evaluateSuspiciousResult(10, 247, GUARDS)).toMatch(/SUSPICIOUS_DROP/);
  });

  it('accepts normal variance', () => {
    expect(evaluateSuspiciousResult(247, 247, GUARDS)).toBeNull();
    expect(evaluateSuspiciousResult(230, 247, GUARDS)).toBeNull();
    expect(evaluateSuspiciousResult(300, 247, GUARDS)).toBeNull();
  });

  it('accepts first-ever syncs without history', () => {
    expect(evaluateSuspiciousResult(19, null, GUARDS)).toBeNull();
    expect(evaluateSuspiciousResult(0, null, GUARDS)).toMatch(/SUSPICIOUS_ZERO_RESULTS/);
  });

  it('enforces the absolute floor against history', () => {
    expect(evaluateSuspiciousResult(0, 5, { minExpectedRecords: 3, maxDropRatio: 0.8 })).toMatch(
      /SUSPICIOUS_ZERO_RESULTS/,
    );
  });
});
