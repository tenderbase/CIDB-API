const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sept: 8, sep: 8,
  oct: 9, nov: 10, dec: 11,
};

/**
 * Best-effort date parser for CIDB source values.
 * Accepts ISO (2026-06-01), SA formats (01/06/2026, 01-06-2026),
 * and long forms (1 June 2026, June 1, 2026). Returns null when unparseable.
 * All dates are interpreted as UTC midnight unless a time is present.
 */
export function parseSourceDate(input: unknown): Date | null {
  if (input === null || input === undefined) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input !== 'string') return null;

  const text = input.trim();
  if (!text) return null;

  // ISO: 2026-06-01 or 2026-06-01T10:00:00
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] ?? 0), +(iso[5] ?? 0), +(iso[6] ?? 0)));
    return isValidDate(d) ? d : null;
  }

  // D/M/YYYY or D-M-YYYY (SA order: day first)
  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(text);
  if (dmy) {
    let year = +dmy[3];
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const d = new Date(Date.UTC(year, +dmy[2] - 1, +dmy[1], +(dmy[4] ?? 0), +(dmy[5] ?? 0)));
    return isValidDate(d) ? d : null;
  }

  // 1 June 2026 / 1st June 2026 / June 1, 2026
  const long1 = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]+)\s+(\d{4})/.exec(text);
  if (long1) {
    const month = MONTHS[long1[2].toLowerCase()];
    if (month !== undefined) {
      const d = new Date(Date.UTC(+long1[3], month, +long1[1]));
      return isValidDate(d) ? d : null;
    }
  }
  const long2 = /^([a-zA-Z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(text);
  if (long2) {
    const month = MONTHS[long2[1].toLowerCase()];
    if (month !== undefined) {
      const d = new Date(Date.UTC(+long2[3], month, +long2[2]));
      return isValidDate(d) ? d : null;
    }
  }

  // Last resort: native parser (handles RFC strings), but guard NaN.
  const fallback = new Date(text);
  return isValidDate(fallback) ? fallback : null;
}

function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime());
}

/** Whole days from now until `date` (negative when past). */
export function daysUntil(date: Date, now = new Date()): number {
  return Math.floor((date.getTime() - now.getTime()) / 86_400_000);
}

export function toIsoOrNull(date: Date | null | undefined): string | null {
  if (!date) return null;
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}
