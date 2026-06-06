// Shared warranty helpers. Pure functions only (no server/client coupling) so
// the same logic feeds: product defaults UI, the three sale-creation paths that
// snapshot warranty onto the line, and the sale detail that reads validity.

export type WarrantyType = 'none' | 'manufacturer' | 'store' | 'extended';

export const WARRANTY_TYPE_LABELS: Record<WarrantyType, string> = {
  none: 'Sin garantía',
  manufacturer: 'Garantía de fábrica',
  store: 'Garantía de la tienda',
  extended: 'Garantía extendida',
};

export const WARRANTY_TYPE_OPTIONS: ReadonlyArray<{
  value: WarrantyType;
  label: string;
}> = (Object.keys(WARRANTY_TYPE_LABELS) as WarrantyType[]).map(value => ({
  value,
  label: WARRANTY_TYPE_LABELS[value],
}));

// Fixed presets for v1 (custom duration is deferred). Stored as a day count so
// the end date is a trivial `start + days` with no calendar ambiguity.
export const WARRANTY_DURATION_OPTIONS: ReadonlyArray<{
  days: number;
  label: string;
}> = [
  { days: 30, label: '30 días' },
  { days: 90, label: '90 días' },
  { days: 180, label: '6 meses' },
  { days: 365, label: '1 año' },
];

export function warrantyDurationLabel(days: number | null | undefined): string {
  if (days == null) {
    return '—';
  }
  const preset = WARRANTY_DURATION_OPTIONS.find(o => o.days === days);
  return preset ? preset.label : `${days} días`;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeWarrantyEndsAt(start: Date, durationDays: number): Date {
  return new Date(start.getTime() + durationDays * MS_PER_DAY);
}

// True when the product actually carries a usable warranty template. NULL type
// or 'none', or a missing/non-positive duration, all mean "no warranty".
export function hasWarranty(input: {
  warrantyType?: WarrantyType | null;
  warrantyDurationDays?: number | null;
}): boolean {
  return (
    input.warrantyType != null
    && input.warrantyType !== 'none'
    && input.warrantyDurationDays != null
    && input.warrantyDurationDays > 0
  );
}

export type WarrantySnapshot = {
  warrantyType: WarrantyType | null;
  warrantyDurationDays: number | null;
  warrantyEndsAt: Date | null;
};

const EMPTY_SNAPSHOT: WarrantySnapshot = {
  warrantyType: null,
  warrantyDurationDays: null,
  warrantyEndsAt: null,
};

// Freezes the product's warranty template onto a sale line. `start` is the sale
// date, so validity is anchored to when the customer bought — never shifts if
// the product's defaults change afterwards. Returns nulls when there's no
// warranty to snapshot.
export function snapshotWarranty(
  product: {
    warrantyType?: WarrantyType | null;
    warrantyDurationDays?: number | null;
  },
  start: Date,
): WarrantySnapshot {
  if (!hasWarranty(product)) {
    return EMPTY_SNAPSHOT;
  }
  const days = product.warrantyDurationDays!;
  return {
    warrantyType: product.warrantyType!,
    warrantyDurationDays: days,
    warrantyEndsAt: computeWarrantyEndsAt(start, days),
  };
}

export function isWarrantyActive(
  endsAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!endsAt) {
    return false;
  }
  const end = endsAt instanceof Date ? endsAt : new Date(endsAt);
  return end.getTime() >= now.getTime();
}
