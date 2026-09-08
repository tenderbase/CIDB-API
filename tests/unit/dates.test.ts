import { describe, expect, it } from 'vitest';
import { daysUntil, parseSourceDate } from '../../src/utils/dates.js';

describe('parseSourceDate', () => {
  it('parses ISO dates', () => {
    expect(parseSourceDate('2026-06-01')?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(parseSourceDate('2026-06-01T10:30:00')?.toISOString()).toBe('2026-06-01T10:30:00.000Z');
  });

  it('parses SA day-first numeric dates', () => {
    expect(parseSourceDate('01/06/2026')?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(parseSourceDate('30-09-2026')?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('parses long-form dates', () => {
    expect(parseSourceDate('1 June 2026')?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(parseSourceDate('June 1, 2026')?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(parseSourceDate('30th September 2026')?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseSourceDate(null)).toBeNull();
    expect(parseSourceDate('')).toBeNull();
    expect(parseSourceDate('not a date')).toBeNull();
    expect(parseSourceDate('Date Advertised: ')).toBeNull();
  });

  it('passes through valid Date instances', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(parseSourceDate(d)).toBe(d);
    expect(parseSourceDate(new Date('invalid'))).toBeNull();
  });
});

describe('daysUntil', () => {
  it('computes whole days until a date', () => {
    const now = new Date('2026-09-07T12:00:00Z');
    expect(daysUntil(new Date('2026-09-10T12:00:00Z'), now)).toBe(3);
    expect(daysUntil(new Date('2026-09-01T12:00:00Z'), now)).toBe(-6);
  });
});
