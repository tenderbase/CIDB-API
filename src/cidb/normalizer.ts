import { NormalizedTender, normalizedTenderSchema, TenderStatusValue } from '../schemas/tender.js';
import { parseSourceDate } from '../utils/dates.js';
import { contentHash, shortHash } from '../utils/hashing.js';
import { ParsedTender } from './types.js';

// ─── Province normalization ────────────────────────────────────────────────

const PROVINCES = [
  'KwaZulu-Natal',
  'Gauteng',
  'Western Cape',
  'Eastern Cape',
  'Free State',
  'Limpopo',
  'Mpumalanga',
  'Northern Cape',
  'North West',
] as const;

/** City/area → province hints for inference from free text. */
const CITY_PROVINCE_HINTS: Array<{ match: RegExp; province: string }> = [
  { match: /\bkwazulu[-\s]?natal\b|\bkzn\b/i, province: 'KwaZulu-Natal' },
  { match: /\bgauteng\b/i, province: 'Gauteng' },
  { match: /\bwestern\s+cape\b/i, province: 'Western Cape' },
  { match: /\beastern\s+cape\b/i, province: 'Eastern Cape' },
  { match: /\bfree\s+state\b|\bloemfontein\b|\bbloem\b/i, province: 'Free State' },
  { match: /\blimpopo\b|\bpolokwane\b/i, province: 'Limpopo' },
  { match: /\bmpumalanga\b|\bmbombela\b|\bnelspruit\b/i, province: 'Mpumalanga' },
  { match: /\bnorthern\s+cape\b|\bkimberley\b/i, province: 'Northern Cape' },
  { match: /\bnorth\s+west\b|\brustenburg\b|\bpotchefstroom\b|\bklerksdorp\b/i, province: 'North West' },
  { match: /\bcape\s+town\b|\bstellenbosch\b|\bpaarl\b|\bgeorge\b/i, province: 'Western Cape' },
  { match: /\bjohannesburg\b|\bjoburg\b|\bpretoria\b|\btshwane\b|\bcenturion\b|\bmidrand\b|\bekurhuleni\b|\bsandton\b|\brandburg\b/i, province: 'Gauteng' },
  { match: /\bdurban\b|\bpietermaritzburg\b|\bumhlanga\b|\brichards\s+bay\b/i, province: 'KwaZulu-Natal' },
  { match: /\bgqeberha\b|\bport\s+elizabeth\b|\beast\s+london\b|\bbhisho\b|\bmakhanda\b|\bgrahamstown\b/i, province: 'Eastern Cape' },
];

/** Normalize a raw province value to the canonical list; null when unknown. */
export function normalizeProvince(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
  for (const province of PROVINCES) {
    if (province.toLowerCase() === cleaned) return province;
  }
  // Common variants.
  const variants: Record<string, string> = {
    kzn: 'KwaZulu-Natal',
    'kwazulu natal': 'KwaZulu-Natal',
    gauteng: 'Gauteng',
    gp: 'Gauteng',
    'western cape': 'Western Cape',
    wc: 'Western Cape',
    'eastern cape': 'Eastern Cape',
    ec: 'Eastern Cape',
    'free state': 'Free State',
    fs: 'Free State',
    limpopo: 'Limpopo',
    mpumalanga: 'Mpumalanga',
    'northern cape': 'Northern Cape',
    nc: 'Northern Cape',
    'north west': 'North West',
    northwest: 'North West',
    'north-west': 'North West',
    nw: 'North West',
  };
  return variants[cleaned] ?? null;
}

/** Best-effort province inference from free text (city/province mentions). */
export function inferProvince(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const hint of CITY_PROVINCE_HINTS) {
    if (hint.match.test(text)) return hint.province;
  }
  return null;
}

// ─── CIDB grade / class ────────────────────────────────────────────────────

/** Matches "Grade 5", "grade 5-7", "Grade 7–9 contractor", "cidb grading of 6". */
const GRADE_PATTERN = /grade\s*(?:of\s*)?([1-9])\s*(?:[-–—]\s*([1-9]))?/i;
const GRADING_OF_PATTERN = /grading\s*(?:of\s*)?([1-9])\s*(?:[-–—]\s*([1-9]))?/i;

export interface GradeParse {
  grade: string | null;
  gradeRaw: string | null;
}

export function parseGrade(text: string | null | undefined): GradeParse {
  if (!text) return { grade: null, gradeRaw: null };
  const match = GRADE_PATTERN.exec(text) ?? GRADING_OF_PATTERN.exec(text);
  if (!match) return { grade: null, gradeRaw: null };
  const from = Number(match[1]);
  const to = match[2] ? Number(match[2]) : null;
  if (to && to > from) return { grade: `${from}-${to}`, gradeRaw: match[0].trim() };
  return { grade: String(from), gradeRaw: match[0].trim() };
}

const KNOWN_CLASSES = ['GB', 'CE', 'ME', 'EC', 'EB', 'EP', 'ES', 'SK', 'SW', 'SO', 'SQ', 'GBE'] as const;

export interface ClassParse {
  classes: string[];
  classRaw: string | null;
}

/**
 * Best-effort CIDB class-of-works extraction. Only matches class codes in
 * explicit CIDB contexts (e.g. "5CE", "class: GB, CE") to avoid false
 * positives from ordinary words.
 */
export function parseClass(text: string | null | undefined): ClassParse {
  if (!text) return { classes: [], classRaw: null };
  const found = new Set<string>();
  const raws: string[] = [];

  // "5CE", "5 CE", "7GB" style designations.
  const designation = /\b([1-9])\s?(GB|CE|ME|EC|EB|EP|ES|SK|SW|SO|SQ)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = designation.exec(text)) !== null) {
    found.add(m[2].toUpperCase());
    raws.push(m[0]);
  }

  // "class(es) ...: GB, CE" style lists.
  const listMatch = /class(?:es)?(?:\s+of\s+works?)?\s*:?\s*([A-Z]{2}(?:\s*[,&/]\s*[A-Z]{2})*)/i.exec(text);
  if (listMatch) {
    const codes = listMatch[1].split(/[\s,&/]+/).filter(Boolean);
    for (const code of codes) {
      const upper = code.toUpperCase();
      if ((KNOWN_CLASSES as readonly string[]).includes(upper)) {
        found.add(upper);
        raws.push(code);
      }
    }
  }

  return { classes: [...found], classRaw: raws.length > 0 ? raws.join(', ') : null };
}

// ─── Dates ─────────────────────────────────────────────────────────────────

/** "Date Advertised: 2026-06-01" → date portion. */
export function extractAdvertisedDate(dateText: string | null | undefined): Date | null {
  if (!dateText) return null;
  const afterColon = dateText.includes(':') ? dateText.split(':').slice(1).join(':').trim() : dateText.trim();
  return parseSourceDate(afterColon) ?? parseSourceDate(dateText);
}

const CLOSING_PATTERNS: RegExp[] = [
  /closing\s+date\s*(?:is|:)?\s*([^\n.;]{4,40})/i,
  /closes?\s+(?:on|at)\s+([^\n.;]{4,40})/i,
  /closing\s*:\s*([^\n.;]{4,40})/i,
  /deadline\s*(?:is|:|for\s+submission)?\s*([^\n.;]{4,40})/i,
];

/** Best-effort closing-date extraction from free text. Null when absent. */
export function extractClosingDate(text: string | null | undefined): Date | null {
  if (!text) return null;
  for (const pattern of CLOSING_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const parsed = parseSourceDate(match[1].trim().replace(/[,;]+$/, ''));
      if (parsed) return parsed;
    }
  }
  return null;
}

// ─── Contact details ───────────────────────────────────────────────────────

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_PATTERN = /(?:\+27|0)\s?\d{2}[\s-]?\d{3}[\s-]?\d{4}/;

export function extractContact(text: string | null | undefined): { email: string | null; phone: string | null } {
  if (!text) return { email: null, phone: null };
  const email = EMAIL_PATTERN.exec(text)?.[0] ?? null;
  const phone = PHONE_PATTERN.exec(text)?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
  return { email, phone };
}

// ─── Briefing ──────────────────────────────────────────────────────────────

export function extractBriefing(text: string | null | undefined): {
  required: boolean;
  date: Date | null;
  location: string | null;
} {
  if (!text) return { required: false, date: null, location: null };
  const required = /compulsory\s+briefing|mandatory\s+briefing|compulsory\s+site\s+meeting|briefing\s+is\s+compulsory/i.test(text);
  if (!/briefing|site\s+meeting|site\s+inspection/i.test(text)) {
    return { required: false, date: null, location: null };
  }
  const dateMatch = /(?:briefing|site\s+(?:meeting|inspection))[^\n.]{0,60}?(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})/i.exec(text);
  const date = dateMatch ? parseSourceDate(dateMatch[1]) : null;
  const locMatch = /(?:briefing|site\s+(?:meeting|inspection))[^\n.]{0,80}?(?:at|venue:?)\s+([^\n.]{3,80})/i.exec(text);
  const location = locMatch ? locMatch[1].trim() : null;
  return { required, date, location };
}

// ─── Title / tender type ───────────────────────────────────────────────────

const MAX_TITLE_LENGTH = 220;

/** First sentence (or truncation) of the details becomes the title. */
export function deriveTitle(description: string | null | undefined, bidNumber: string | null): string {
  const text = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return bidNumber ? `CIDB tender ${bidNumber}` : 'CIDB tender';
  const sentenceEnd = text.search(/[.!?]\s/);
  let title = sentenceEnd > 20 ? text.slice(0, sentenceEnd).trim() : text;
  if (title.length > MAX_TITLE_LENGTH) {
    title = `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
  }
  return title || (bidNumber ? `CIDB tender ${bidNumber}` : 'CIDB tender');
}

const TYPE_RULES: Array<{ match: RegExp; type: string }> = [
  { match: /consult(ing|ant|ancy)|advisory|advisor|professional\s+services|audit/i, type: 'Consulting' },
  { match: /\bconstruction\b|\bbuilding\b|\bcivil\b|\bcontractor\b|\brefurbish|\bpainting\b|\breticulation\b|\bearthing\b/i, type: 'Works' },
  { match: /supply|deliver|procurement|equipment|furniture|hardware|desktops|computer/i, type: 'Supply' },
  { match: /maintenance|support|services|service\s+provider|cleaning|security|marketing|catering/i, type: 'Services' },
];

/** Best-effort tender-type classification from free text. */
export function inferTenderType(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const rule of TYPE_RULES) {
    if (rule.match.test(text)) return rule.type;
  }
  return null;
}

// ─── Bid number / external ID ──────────────────────────────────────────────

/** "cidb 004 2627" → "CIDB-004-2627". Null-safe. */
export function normalizeBidNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.toUpperCase() : null;
}

export function slugifyBidNumber(raw: string | null | undefined): string | null {
  const normalized = normalizeBidNumber(raw);
  if (!normalized) return null;
  const slug = normalized
    .replace(/[^A-Z0-9]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toUpperCase();
  return slug || null;
}

/**
 * Deterministic external ID. Prefers the normalized bid number; falls back
 * to a content hash when the source exposes no bid number. Never random.
 */
export function buildExternalId(input: {
  bidNumber: string | null;
  title: string;
  publishedDateText: string | null;
  sourceUrl: string;
}): string {
  const slug = slugifyBidNumber(input.bidNumber);
  if (slug) return `CIDB-${slug}`;
  const fallback = shortHash(`${input.title}|${input.publishedDateText ?? ''}|${input.sourceUrl}`, 16);
  return `CIDB-${fallback}`;
}

/**
 * Disambiguate duplicate external IDs *within a single sync run*
 * (the CIDB listing occasionally repeats a bid number). Deterministic:
 * rows are ordered by rawHash and suffixed -2, -3, …; the first keeps
 * the base ID.
 */
export function ensureUniqueExternalIds<T extends { externalId: string; rawHash: string }>(tenders: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const tender of tenders) {
    const group = groups.get(tender.externalId) ?? [];
    group.push(tender);
    groups.set(tender.externalId, group);
  }
  const result: T[] = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const ordered = [...group].sort((a, b) => (a.rawHash < b.rawHash ? -1 : a.rawHash > b.rawHash ? 1 : 0));
    ordered.forEach((tender, index) => {
      result.push(index === 0 ? tender : { ...tender, externalId: `${tender.externalId}-${index + 1}` });
    });
  }
  return result;
}

// ─── Documents ─────────────────────────────────────────────────────────────

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  csv: 'text/csv',
  zip: 'application/zip',
  txt: 'text/plain',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export type DocumentKind =
  | 'BID_DOCUMENT'
  | 'ADDENDUM'
  | 'OPENING_REGISTER'
  | 'BRIEFING_NOTE'
  | 'PRICING_SCHEDULE'
  | 'OTHER';

export function classifyDocument(label: string | null, url: string): DocumentKind {
  const haystack = `${label ?? ''} ${url}`.toLowerCase();
  if (/bid\s+opening|opening\s+register|open\s+register/.test(haystack)) return 'OPENING_REGISTER';
  if (/addendum/.test(haystack)) return 'ADDENDUM';
  if (/briefing|msa\s+draft/.test(haystack)) return 'BRIEFING_NOTE';
  if (/pricing|boq|schedule/.test(haystack)) return 'PRICING_SCHEDULE';
  if (/bid\s+document|tender\s+document|get\s+bid/.test(haystack)) return 'BID_DOCUMENT';
  return 'OTHER';
}

export function fileNameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').filter(Boolean).pop();
    if (!last) return null;
    return decodeURIComponent(last);
  } catch {
    return null;
  }
}

export function mimeTypeFromFileName(fileName: string | null): string | null {
  if (!fileName) return null;
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? null;
}

// ─── Status ────────────────────────────────────────────────────────────────

/**
 * Derive the stored status. The current-tenders listing implies OPEN; a
 * known closing date refines it. Source-asserted terminal states
 * (CLOSED/CANCELLED/AWARDED/ARCHIVED) always win.
 */
export function deriveStatus(input: {
  sourceStatus?: TenderStatusValue | null;
  closingDate: Date | null;
  closingSoonDays: number;
  now?: Date;
}): TenderStatusValue {
  const { sourceStatus, closingDate, closingSoonDays, now = new Date() } = input;
  if (sourceStatus && ['CLOSED', 'CANCELLED', 'AWARDED', 'ARCHIVED'].includes(sourceStatus)) {
    return sourceStatus;
  }
  if (!closingDate) return 'OPEN';
  const diffDays = (closingDate.getTime() - now.getTime()) / 86_400_000;
  if (diffDays < 0) return 'CLOSED';
  if (diffDays <= closingSoonDays) return 'CLOSING_SOON';
  return 'OPEN';
}

// ─── Main entry ────────────────────────────────────────────────────────────

export interface NormalizeOptions {
  source?: string;
  closingSoonDays?: number;
  defaultOrganisation?: string;
  now?: Date;
}

/** Normalize one parsed record into the validated Tender schema. */
export function normalizeParsedTender(parsed: ParsedTender, options: NormalizeOptions = {}): NormalizedTender {
  const {
    source = 'CIDB',
    closingSoonDays = 7,
    defaultOrganisation = 'Construction Industry Development Board',
    now = new Date(),
  } = options;

  const bidNumber = normalizeBidNumber(parsed.bidNumber);
  const description = parsed.description?.trim() || null;
  const title = deriveTitle(description, bidNumber);
  const publishedDate = extractAdvertisedDate(parsed.publishedDate);
  const closingDate = extractClosingDate(description);

  const combinedText = [title, description, parsed.locationText].filter(Boolean).join('\n');
  const province = inferProvince(combinedText);
  const grade = parseGrade(combinedText);
  const classes = parseClass(combinedText);
  const contact = extractContact(combinedText);
  const briefing = extractBriefing(combinedText);
  const tenderType = inferTenderType(combinedText);
  const status = deriveStatus({ closingDate, closingSoonDays, now });

  // Documents: classify, enrich, dedupe by URL (keep first occurrence).
  const seenUrls = new Set<string>();
  const documents = parsed.documents
    .filter((d) => d.url && !seenUrls.has(d.url) && (seenUrls.add(d.url), true))
    .map((d) => {
      const fileName = fileNameFromUrl(d.url);
      return {
        name: d.name,
        documentType: classifyDocument(d.label, d.url),
        url: d.url,
        sourceUrl: parsed.sourceUrl,
        fileName,
        mimeType: mimeTypeFromFileName(fileName),
      };
    });

  const rawData = {
    bidNumberRaw: parsed.extra?.bidNumberRaw ?? parsed.bidNumber,
    dateRaw: parsed.extra?.dateRaw ?? parsed.publishedDate,
    descriptionRaw: parsed.description,
    sourceUrl: parsed.sourceUrl,
    documentUrls: parsed.documents.map((d) => ({ label: d.label, url: d.url })),
    inferred: { province, tenderType, closingDate: closingDate?.toISOString() ?? null },
  };
  const rawHash = contentHash({
    bidNumber,
    title,
    description,
    publishedDate: publishedDate?.toISOString() ?? null,
    closingDate: closingDate?.toISOString() ?? null,
    documents: documents.map((d) => d.url).sort(),
    sourceUrl: parsed.sourceUrl,
  });

  const externalId = buildExternalId({
    bidNumber,
    title,
    publishedDateText: parsed.publishedDate,
    sourceUrl: parsed.sourceUrl,
  });

  return normalizedTenderSchema.parse({
    source,
    externalId,
    bidNumber,
    title,
    description,
    organisation: parsed.organisation ?? defaultOrganisation,
    province,
    location: null,
    municipality: null,
    tenderType,
    status,
    publishedDate,
    closingDate,
    briefingDate: briefing.date,
    briefingRequired: briefing.required,
    briefingLocation: briefing.location,
    cidbGrade: grade.grade,
    cidbGradeRaw: grade.gradeRaw,
    cidbClass: classes.classes,
    cidbClassRaw: classes.classRaw,
    estimatedValue: null,
    contactName: null,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    sourceUrl: parsed.sourceUrl,
    rawHash,
    rawData,
    documents,
  });
}
