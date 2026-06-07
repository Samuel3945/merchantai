// Client-safe presentation + pure logic for the Fiados module. NO server-only
// imports (no db, no clerk, no node:*) so client components can import it without
// pulling the data layer into the bundle. Mirrors the cash-ui / cash-helpers
// split. The server core (libs/fiados.ts) re-uses these same pure helpers, so
// the due-date rules are defined exactly once.

export type FiadoDueState = 'overdue' | 'due_soon' | 'on_track' | 'paid';

// "Próximo a vencer": due today or within this many days.
export const DUE_SOON_DAYS = 3;

export const FIADO_PAYMENT_METHODS = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'nequi', label: 'Nequi' },
  { value: 'daviplata', label: 'Daviplata' },
  { value: 'transferencia', label: 'Transferencia' },
  { value: 'otro', label: 'Otro' },
] as const;

// Whole-day signed difference to the due date. Negative = overdue, 0 = due
// today, positive = days remaining. Uses local midnight so "Vence mañana" is
// truthful regardless of the time of day.
export function daysUntilDue(dueDate: string, today: Date = new Date()): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const localMidnight = new Date(
    today.getTime() - today.getTimezoneOffset() * 60_000,
  )
    .toISOString()
    .slice(0, 10);
  const t0 = Date.parse(`${localMidnight}T00:00:00Z`);
  if (Number.isNaN(due)) {
    return 0;
  }
  return Math.round((due - t0) / 86_400_000);
}

export function deriveDueState(
  dueDate: string,
  isPaid: boolean,
  today: Date = new Date(),
): { state: FiadoDueState; days: number } {
  if (isPaid) {
    return { state: 'paid', days: 0 };
  }
  const days = daysUntilDue(dueDate, today);
  if (days < 0) {
    return { state: 'overdue', days };
  }
  if (days <= DUE_SOON_DAYS) {
    return { state: 'due_soon', days };
  }
  return { state: 'on_track', days };
}

export function addDaysISO(base: Date, days: number): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Plain-language label for a due state, from the tendero's point of view.
// e.g. "Atrasado 8 días", "Vence mañana", "Vence en 12 días", "Pagado".
export function dueStateLabel(state: FiadoDueState, days: number): string {
  switch (state) {
    case 'paid':
      return 'Pagado';
    case 'overdue': {
      const d = Math.abs(days);
      return d === 0 ? 'Vence hoy' : `Atrasado ${d} ${d === 1 ? 'día' : 'días'}`;
    }
    case 'due_soon':
      if (days === 0) {
        return 'Vence hoy';
      }
      if (days === 1) {
        return 'Vence mañana';
      }
      return `Vence en ${days} días`;
    case 'on_track':
    default:
      return `Vence en ${days} ${days === 1 ? 'día' : 'días'}`;
  }
}
