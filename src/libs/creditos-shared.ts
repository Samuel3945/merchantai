// Client-safe presentation + pure logic for the Creditos module. NO server-only
// imports (no db, no clerk, no node:*) so client components can import it without
// pulling the data layer into the bundle. Mirrors the cash-ui / cash-helpers
// split. The server core (libs/creditos.ts) re-uses these same pure helpers, so
// the due-date rules are defined exactly once.

export type CreditoDueState = 'overdue' | 'due_soon' | 'on_track' | 'paid';

// "Próximo a vencer": due today or within this many days.
export const DUE_SOON_DAYS = 3;

// Legacy generic tokens. The abono picker no longer uses these — it sources the
// merchant's REAL methods (see AbonoMethod below). Kept only as a label fallback
// for old ledger rows that were recorded with these generic values.
export const CREDITO_PAYMENT_METHODS = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'nequi', label: 'Nequi' },
  { value: 'daviplata', label: 'Daviplata' },
  { value: 'transferencia', label: 'Transferencia' },
  { value: 'otro', label: 'Otro' },
] as const;

// ── Abono payment methods (real, org-configured) ─────────────────────────────

export type AbonoMethodType = 'cash' | 'transfer' | 'card' | 'other';

// A payment method as shown in the abono picker. Sourced from the real
// payment_methods table (actions/payment-methods.ts), NOT the hardcoded list
// above. `value` is the method's unique name and is sent to the ledger verbatim:
// a transfer abono attributes to the right bank account because
// treasury.resolveBancoForMethod matches on payment_methods.name.
export type AbonoMethod = {
  value: string;
  label: string;
  type: AbonoMethodType;
  icon: string | null;
  subtitle: string | null;
};

// Structural shape of a payment_methods row — declared locally so this
// client-safe module never imports the server data layer.
type PaymentMethodLike = {
  name: string;
  type: string;
  icon?: string | null;
  details?: unknown;
};

// Maps active payment methods to abono options. Credit is dropped (you can't pay
// a credit with credit); order is preserved so cash (seeded first) stays first,
// then the merchant's own accounts in their configured order. Each transfer
// account is its own option — the cashier POS does the same, so the abono
// records WHICH account received the money.
export function toAbonoMethods(rows: PaymentMethodLike[]): AbonoMethod[] {
  return rows
    .filter(r => r.type !== 'credit')
    .map((r) => {
      const type: AbonoMethodType
        = r.type === 'cash' || r.type === 'transfer' || r.type === 'card'
          ? r.type
          : 'other';
      const account
        = type === 'transfer'
          ? (r.details as { account_number?: string } | null)?.account_number
          ?? null
          : null;
      return {
        value: r.name,
        label: r.name,
        type,
        icon: r.icon ?? null,
        subtitle: account,
      };
    });
}

// The picker defaults to cash (the usual counter payment), falling back to the
// first available method if cash is somehow absent.
export function defaultAbonoMethod(methods: AbonoMethod[]): string {
  const cash = methods.find(m => m.type === 'cash');
  return cash?.value ?? methods[0]?.value ?? '';
}

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
): { state: CreditoDueState; days: number } {
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
export function dueStateLabel(state: CreditoDueState, days: number): string {
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
