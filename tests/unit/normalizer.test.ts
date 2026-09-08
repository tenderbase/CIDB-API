import { describe, expect, it } from 'vitest';
import {
  buildExternalId,
  classifyDocument,
  deriveStatus,
  deriveTitle,
  ensureUniqueExternalIds,
  extractAdvertisedDate,
  extractBriefing,
  extractClosingDate,
  extractContact,
  fileNameFromUrl,
  inferProvince,
  inferTenderType,
  mimeTypeFromFileName,
  normalizeBidNumber,
  normalizeParsedTender,
  normalizeProvince,
  parseClass,
  parseGrade,
  slugifyBidNumber,
} from '../../src/cidb/normalizer.js';
import { ParsedTender } from '../../src/cidb/types.js';

const SOURCE_URL = 'https://www.cidb.org.za/cidb-tenders/current-tenders/';

function parsed(overrides: Partial<ParsedTender> = {}): ParsedTender {
  return {
    bidNumber: 'cidb 004 2627',
    title: null,
    description: 'Appointment of a service provider for electrical works in Centurion.',
    organisation: null,
    publishedDate: 'Date Advertised: 2026-06-01',
    closingDate: null,
    locationText: null,
    documents: [],
    sourceUrl: SOURCE_URL,
    extra: {},
    ...overrides,
  };
}

describe('province normalization', () => {
  it('normalizes canonical names and common variants', () => {
    expect(normalizeProvince('KwaZulu-Natal')).toBe('KwaZulu-Natal');
    expect(normalizeProvince('kzn')).toBe('KwaZulu-Natal');
    expect(normalizeProvince('kwazulu natal')).toBe('KwaZulu-Natal');
    expect(normalizeProvince('North-West')).toBe('North West');
    expect(normalizeProvince('western cape')).toBe('Western Cape');
    expect(normalizeProvince('Atlantis')).toBeNull();
    expect(normalizeProvince(null)).toBeNull();
  });

  it('infers province from city and province mentions', () => {
    expect(inferProvince('office in Durban, KwaZulu-Natal')).toBe('KwaZulu-Natal');
    expect(inferProvince('head office in Centurion')).toBe('Gauteng');
    expect(inferProvince('provincial office in Nelspruit')).toBe('Mpumalanga');
    expect(inferProvince('site in Bloemfontein, Free State')).toBe('Free State');
    expect(inferProvince('no location hints here')).toBeNull();
  });
});

describe('grade parsing', () => {
  it('parses single grades and ranges', () => {
    expect(parseGrade('contractor applications of Grade 5')).toMatchObject({ grade: '5' });
    expect(parseGrade('Grade 7-9 contractor applications')).toMatchObject({ grade: '7-9' });
    expect(parseGrade('Grade 7–9 contractor applications')).toMatchObject({ grade: '7-9' });
    expect(parseGrade('cidb grading of 6 required')).toMatchObject({ grade: '6' });
    expect(parseGrade('no grade mentioned')).toMatchObject({ grade: null, gradeRaw: null });
  });

  it('keeps the raw matched value', () => {
    expect(parseGrade('Grade 7-9 contractor applications').gradeRaw).toBe('Grade 7-9');
  });
});

describe('class parsing', () => {
  it('extracts designations like 5CE without false positives', () => {
    expect(parseClass('requires a 5CE contractor')).toMatchObject({ classes: ['CE'] });
    expect(parseClass('grading 7GB or higher')).toMatchObject({ classes: ['GB'] });
    expect(parseClass('give me a break')).toMatchObject({ classes: [] });
    expect(parseClass('the service provider must deliver')).toMatchObject({ classes: [] });
  });

  it('extracts explicit class lists', () => {
    expect(parseClass('class of works: GB, CE')).toMatchObject({ classes: ['GB', 'CE'] });
    expect(parseClass('nothing here')).toMatchObject({ classes: [] });
  });
});

describe('date extraction', () => {
  it('extracts the advertised date', () => {
    expect(extractAdvertisedDate('Date Advertised: 2026-06-01')?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(extractAdvertisedDate('2026-05-29')?.toISOString()).toBe('2026-05-29T00:00:00.000Z');
    expect(extractAdvertisedDate(null)).toBeNull();
    expect(extractAdvertisedDate('')).toBeNull();
  });

  it('extracts closing dates from free text', () => {
    expect(extractClosingDate('Closing date: 30 September 2026')?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(extractClosingDate('Tender closes on 01/10/2026 at 11:00')?.toISOString()).toContain('2026-10-01');
    expect(extractClosingDate('no closing info')).toBeNull();
  });
});

describe('contact and briefing extraction', () => {
  it('extracts email and SA phone numbers', () => {
    expect(extractContact('Enquiries: tenders@example.co.za or 012 482 7200')).toEqual({
      email: 'tenders@example.co.za',
      phone: '012 482 7200',
    });
    expect(extractContact('no contacts')).toEqual({ email: null, phone: null });
  });

  it('detects compulsory briefings', () => {
    const briefing = extractBriefing('Compulsory briefing session on 12 June 2026 at cidb Head Office, Centurion.');
    expect(briefing.required).toBe(true);
    expect(briefing.date?.toISOString()).toBe('2026-06-12T00:00:00.000Z');
    expect(briefing.location).toContain('cidb Head Office');
    expect(extractBriefing('no briefing mentioned')).toMatchObject({ required: false, date: null });
  });
});

describe('title, bid number and external ID', () => {
  it('derives a sentence-based title', () => {
    expect(deriveTitle('Appointment of a cleaner. Second sentence here.', 'B1')).toBe('Appointment of a cleaner');
    expect(deriveTitle(null, 'B1')).toBe('CIDB tender B1');
  });

  it('truncates very long titles', () => {
    const long = 'Appointment '.repeat(30);
    const title = deriveTitle(long, 'B1');
    expect(title.length).toBeLessThanOrEqual(220);
    expect(title.endsWith('…')).toBe(true);
  });

  it('normalizes bid numbers', () => {
    expect(normalizeBidNumber('cidb 004 2627')).toBe('CIDB 004 2627');
    expect(slugifyBidNumber('cidb 004 2627')).toBe('CIDB-004-2627');
    expect(slugifyBidNumber(null)).toBeNull();
  });

  it('builds deterministic bid-based external IDs', () => {
    const id = buildExternalId({ bidNumber: 'cidb 004 2627', title: 't', publishedDateText: null, sourceUrl: SOURCE_URL });
    expect(id).toBe('CIDB-CIDB-004-2627');
    const again = buildExternalId({ bidNumber: 'cidb 004 2627', title: 'different title', publishedDateText: null, sourceUrl: SOURCE_URL });
    expect(again).toBe(id);
  });

  it('falls back to a deterministic hash without a bid number', () => {
    const input = { bidNumber: null, title: 'Some tender', publishedDateText: '2026-01-01', sourceUrl: SOURCE_URL };
    expect(buildExternalId(input)).toBe(buildExternalId(input));
    expect(buildExternalId({ ...input, title: 'Other tender' })).not.toBe(buildExternalId(input));
  });

  it('disambiguates duplicate external IDs deterministically', () => {
    const rows = [
      { externalId: 'CIDB-X', rawHash: 'ccc' },
      { externalId: 'CIDB-X', rawHash: 'aaa' },
      { externalId: 'CIDB-Y', rawHash: 'zzz' },
    ];
    const unique = ensureUniqueExternalIds(rows);
    const ids = unique.map((r) => r.externalId).sort();
    expect(ids).toEqual(['CIDB-X', 'CIDB-X-2', 'CIDB-Y']);
    // Deterministic: same input order always yields the same assignment.
    expect(ensureUniqueExternalIds(rows).map((r) => r.externalId).sort()).toEqual(ids);
  });
});

describe('document helpers', () => {
  it('classifies documents by label and URL', () => {
    expect(classifyDocument('GET BID DOCUMENT', 'https://x.test/a.pdf')).toBe('BID_DOCUMENT');
    expect(classifyDocument('GET ADDENDUM', 'https://x.test/b.pdf')).toBe('ADDENDUM');
    expect(classifyDocument('BID OPENING REGISTER', 'https://x.test/c.pdf')).toBe('OPENING_REGISTER');
    expect(classifyDocument('BRIEFING NOTE', 'https://x.test/d.pdf')).toBe('BRIEFING_NOTE');
    expect(classifyDocument('Click here', 'https://x.test/pricing-schedule.xlsx')).toBe('PRICING_SCHEDULE');
    expect(classifyDocument('Click here', 'https://x.test/something.pdf')).toBe('OTHER');
  });

  it('derives file names and MIME types', () => {
    expect(fileNameFromUrl('https://x.test/a%20b.PDF?x=1')).toBe('a b.PDF');
    expect(mimeTypeFromFileName('doc.pdf')).toBe('application/pdf');
    expect(mimeTypeFromFileName('sheet.XLSX')).toContain('spreadsheet');
    expect(mimeTypeFromFileName('archive.unknownext')).toBeNull();
  });
});

describe('status derivation', () => {
  const now = new Date('2026-09-07T12:00:00.000Z');
  it('keeps terminal source states', () => {
    expect(deriveStatus({ sourceStatus: 'CANCELLED', closingDate: null, closingSoonDays: 7, now })).toBe('CANCELLED');
    expect(deriveStatus({ sourceStatus: 'AWARDED', closingDate: null, closingSoonDays: 7, now })).toBe('AWARDED');
  });

  it('uses the closing date when known', () => {
    expect(deriveStatus({ closingDate: null, closingSoonDays: 7, now })).toBe('OPEN');
    expect(
      deriveStatus({ closingDate: new Date('2026-09-10T00:00:00Z'), closingSoonDays: 7, now }),
    ).toBe('CLOSING_SOON');
    expect(
      deriveStatus({ closingDate: new Date('2026-12-01T00:00:00Z'), closingSoonDays: 7, now }),
    ).toBe('OPEN');
    expect(
      deriveStatus({ closingDate: new Date('2026-09-01T00:00:00Z'), closingSoonDays: 7, now }),
    ).toBe('CLOSED');
  });
});

describe('tender type inference', () => {
  it('classifies by keyword', () => {
    expect(inferTenderType('appointment of a forensic auditing firm')).toBe('Consulting');
    expect(inferTenderType('supply and delivery of desktops')).toBe('Supply');
    expect(inferTenderType('cleaning and hygiene services')).toBe('Services');
    expect(inferTenderType('construction of boundary wall by contractor')).toBe('Works');
    expect(inferTenderType('request for proposal for office accommodation')).toBeNull();
  });
});

describe('normalizeParsedTender', () => {
  it('produces a fully validated tender', () => {
    const tender = normalizeParsedTender(
      parsed({
        description:
          'Request for proposal for the purchase of suitable office accommodation for the cidb provincial office in Durban, KwaZulu-Natal. Closing date: 30 September 2026. Enquiries: tenders@example.co.za.',
        documents: [
          { name: 'GET BID DOCUMENT', url: 'https://x.test/doc.pdf', label: 'GET BID DOCUMENT' },
          { name: 'GET BID DOCUMENT', url: 'https://x.test/doc.pdf', label: 'GET BID DOCUMENT' },
        ],
      }),
      { now: new Date('2026-09-07T12:00:00Z') },
    );

    expect(tender.source).toBe('CIDB');
    expect(tender.externalId).toBe('CIDB-CIDB-004-2627');
    expect(tender.bidNumber).toBe('CIDB 004 2627');
    expect(tender.province).toBe('KwaZulu-Natal');
    expect(tender.publishedDate?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(tender.closingDate?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(tender.contactEmail).toBe('tenders@example.co.za');
    expect(tender.organisation).toBe('Construction Industry Development Board');
    // Duplicate document URLs are deduped.
    expect(tender.documents).toHaveLength(1);
    expect(tender.documents[0].documentType).toBe('BID_DOCUMENT');
    expect(tender.documents[0].mimeType).toBe('application/pdf');
    expect(tender.rawHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tender.status).toBe('OPEN');
  });

  it('is deterministic: same input yields same externalId and rawHash', () => {
    const a = normalizeParsedTender(parsed());
    const b = normalizeParsedTender(parsed());
    expect(a.externalId).toBe(b.externalId);
    expect(a.rawHash).toBe(b.rawHash);
  });

  it('changes rawHash when the source record changes', () => {
    const a = normalizeParsedTender(parsed());
    const b = normalizeParsedTender(parsed({ description: 'Something completely different in Polokwane.' }));
    expect(a.rawHash).not.toBe(b.rawHash);
    expect(a.externalId).toBe(b.externalId); // same bid → same identity
  });
});
