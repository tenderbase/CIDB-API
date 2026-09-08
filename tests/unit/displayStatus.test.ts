import { describe, expect, it } from 'vitest';
import { resolveDisplayStatus } from '../../src/services/tenderService.js';

describe('resolveDisplayStatus', () => {
  const now = new Date('2026-09-07T12:00:00.000Z');

  it('keeps terminal states untouched', () => {
    for (const stored of ['CLOSED', 'CANCELLED', 'AWARDED', 'ARCHIVED'] as const) {
      expect(resolveDisplayStatus(stored, new Date('2027-01-01T00:00:00Z'), 7, now)).toBe(stored);
    }
  });

  it('re-evaluates open rows against the closing date', () => {
    expect(resolveDisplayStatus('OPEN', null, 7, now)).toBe('OPEN');
    expect(resolveDisplayStatus('UNKNOWN', null, 7, now)).toBe('UNKNOWN');
    expect(resolveDisplayStatus('OPEN', new Date('2026-09-10T00:00:00Z'), 7, now)).toBe('CLOSING_SOON');
    expect(resolveDisplayStatus('CLOSING_SOON', new Date('2027-01-01T00:00:00Z'), 7, now)).toBe('OPEN');
    expect(resolveDisplayStatus('OPEN', new Date('2026-09-01T00:00:00Z'), 7, now)).toBe('CLOSED');
  });
});
