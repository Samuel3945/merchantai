// Shared date-range helpers for the dashboard period control and any view that
// reuses the Shopify-style DateRangePicker (sales today, reports next). All math
// runs on 'YYYY-MM-DD' strings anchored to America/Bogota so the calendar day
// matches what the store experiences, with no UTC drift.

export type RangePreset
  = | 'today'
    | 'yesterday'
    | '7d'
    | '30d'
    | '90d'
    | 'mtd'
    | 'lastMonth';

export const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'today', label: 'Hoy' },
  { key: 'yesterday', label: 'Ayer' },
  { key: '7d', label: 'Últimos 7 días' },
  { key: '30d', label: 'Últimos 30 días' },
  { key: '90d', label: 'Últimos 90 días' },
  { key: 'mtd', label: 'Este mes' },
  { key: 'lastMonth', label: 'Mes pasado' },
];

export type RangeOption = {
  key: string;
  label: string;
  range: { start: string; end: string };
};

/** Today as 'YYYY-MM-DD' in the store's timezone, not the server/UTC day. */
export function todayBogota(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find(p => p.type === 'year')?.value ?? '1970';
  const m = parts.find(p => p.type === 'month')?.value ?? '01';
  const d = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) {
    return iso;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function diffDays(start: string, end: string): number {
  const [ys, ms, ds] = start.split('-').map(Number);
  const [ye, me, de] = end.split('-').map(Number);
  if (!ys || !ms || !ds || !ye || !me || !de) {
    return 0;
  }
  const a = Date.UTC(ys, ms - 1, ds);
  const b = Date.UTC(ye, me - 1, de);
  return Math.round((b - a) / 86_400_000);
}

/** The period immediately before [start, end], same span — used by "compare". */
export function computePreviousRange(start: string, end: string) {
  const span = diffDays(start, end);
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -span);
  return { start: prevStart, end: prevEnd };
}

export function presetRange(preset: RangePreset): { start: string; end: string } {
  const end = todayBogota();
  switch (preset) {
    case 'today':
      return { start: end, end };
    case 'yesterday': {
      const y = addDays(end, -1);
      return { start: y, end: y };
    }
    case '7d':
      return { start: addDays(end, -6), end };
    case '30d':
      return { start: addDays(end, -29), end };
    case '90d':
      return { start: addDays(end, -89), end };
    case 'mtd':
      return { start: `${end.slice(0, 7)}-01`, end };
    case 'lastMonth': {
      const [y, m] = end.split('-').map(Number);
      const firstThis = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1));
      const lastPrev = new Date(firstThis);
      lastPrev.setUTCDate(0); // rolls back to the last day of the previous month
      const firstPrev = new Date(
        Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1),
      );
      return {
        start: firstPrev.toISOString().slice(0, 10),
        end: lastPrev.toISOString().slice(0, 10),
      };
    }
    default:
      return { start: addDays(end, -6), end };
  }
}

/**
 * Precomputed preset options for the DateRangePicker. Pass a subset of keys to
 * tailor the list per view (e.g. sales omits "Últimos 90 días").
 */
export function buildPresetOptions(keys?: RangePreset[]): RangeOption[] {
  const list = keys
    ? RANGE_PRESETS.filter(p => keys.includes(p.key))
    : RANGE_PRESETS;
  return list.map(p => ({
    key: p.key,
    label: p.label,
    range: presetRange(p.key),
  }));
}
