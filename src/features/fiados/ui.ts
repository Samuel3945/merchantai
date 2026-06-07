import type { FiadoDueState } from '@/libs/fiados-shared';

// Client-safe presentation helpers shared by the Fiados list and detail views:
// COP formatting, dates in America/Bogota, relative time, and the semantic
// colours for each due state (red overdue / amber due-soon / green on-track).

const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function formatMoney(n: number): string {
  return moneyFmt.format(Number.isFinite(n) ? n : 0);
}

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Bogota',
});

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) {
    return '—';
  }
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

const dateTimeFmt = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) {
    return '—';
  }
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? '—' : dateTimeFmt.format(d);
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

/** Bank-app style relative time, e.g. "hace 5 minutos". */
export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) {
    return '—';
  }
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) {
    return '—';
  }
  const diffSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) {
    return 'hace un momento';
  }
  if (abs < 3600) {
    return rtf.format(Math.round(diffSec / 60), 'minute');
  }
  if (abs < 86_400) {
    return rtf.format(Math.round(diffSec / 3600), 'hour');
  }
  return rtf.format(Math.round(diffSec / 86_400), 'day');
}

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export type DueMeta = {
  badge: BadgeVariant;
  /** Left accent border for the card. */
  tint: string;
  /** Timeline / status dot. */
  dot: string;
  /** Progress-bar fill. */
  bar: string;
};

export const DUE_STATE_META: Record<FiadoDueState, DueMeta> = {
  overdue: {
    badge: 'destructive',
    tint: 'border-l-destructive',
    dot: 'bg-destructive',
    bar: 'bg-destructive',
  },
  due_soon: {
    badge: 'secondary',
    tint: 'border-l-amber-500',
    dot: 'bg-amber-500',
    bar: 'bg-amber-500',
  },
  on_track: {
    badge: 'outline',
    tint: 'border-l-emerald-500',
    dot: 'bg-emerald-500',
    bar: 'bg-emerald-500',
  },
  paid: {
    badge: 'outline',
    tint: 'border-l-emerald-500',
    dot: 'bg-emerald-500',
    bar: 'bg-emerald-500',
  },
};
