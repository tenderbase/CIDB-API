import { describe, expect, it } from 'vitest';
import { buildTenderWhere } from '../../src/services/tenderService.js';
import { tenderListQuerySchema } from '../../src/schemas/query.js';

describe('tender list query schema', () => {
  it('applies defaults', () => {
    expect(tenderListQuerySchema.parse({})).toMatchObject({ page: 1, limit: 25, sort: 'publishedDate', order: 'desc' });
  });

  it('coerces querystring numbers and rejects over-limit pages', () => {
    expect(tenderListQuerySchema.parse({ page: '2', limit: '10' })).toMatchObject({ page: 2, limit: 10 });
    expect(tenderListQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(() => tenderListQuerySchema.parse({ limit: '101' })).toThrow();
  });

  it('rejects invalid sort fields, statuses and dates', () => {
    expect(() => tenderListQuerySchema.parse({ sort: 'rawHash' })).toThrow();
    expect(() => tenderListQuerySchema.parse({ status: 'BOGUS' })).toThrow();
    expect(() => tenderListQuerySchema.parse({ publishedFrom: 'not-a-date' })).toThrow();
    expect(() => tenderListQuerySchema.parse({ page: 0 })).toThrow();
  });
});

describe('buildTenderWhere', () => {
  const base = tenderListQuerySchema.parse({});

  it('maps OPEN to OPEN + CLOSING_SOON', () => {
    const where = buildTenderWhere({ ...base, status: 'OPEN' });
    expect(where).toEqual({ AND: [{ status: { in: ['OPEN', 'CLOSING_SOON'] } }] });
  });

  it('maps other statuses exactly', () => {
    expect(buildTenderWhere({ ...base, status: 'CLOSED' })).toEqual({ AND: [{ status: 'CLOSED' }] });
  });

  it('builds search across text fields', () => {
    const where = buildTenderWhere({ ...base, search: 'road' });
    const or = (where.AND?.[0] as { OR: unknown[] }).OR;
    expect(or).toHaveLength(6);
  });

  it('builds province, grade, class and date filters', () => {
    const where = buildTenderWhere({
      ...base,
      province: 'Gauteng',
      cidbGrade: '6',
      cidbClass: 'ce',
      publishedFrom: '2026-01-01',
      closingTo: '2026-12-31',
    });
    expect(where.AND).toContainEqual({ province: { equals: 'Gauteng', mode: 'insensitive' } });
    expect(where.AND).toContainEqual({ cidbGrade: '6' });
    expect(where.AND).toContainEqual({ cidbClass: { has: 'CE' } });
    expect(where.AND).toContainEqual({ publishedDate: { gte: new Date('2026-01-01') } });
    expect(where.AND).toContainEqual({ closingDate: { lte: new Date('2026-12-31') } });
  });

  it('returns an empty filter when no filters are set', () => {
    expect(buildTenderWhere(base)).toEqual({});
  });
});
