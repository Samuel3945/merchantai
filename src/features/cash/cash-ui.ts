import type { CashMovement, CashMovementType } from '@/libs/cash-helpers';

// Client-safe presentation layer for the Caja module. Maps the simple
// user-facing model (Entrada / Salida + motivo + categoría) onto the existing
// cash_movements.type enum, and provides labels + formatting shared by the
// hero, the quick-action modal and the activity feed.
//
// IMPORTANT: only type-only imports from cash-helpers are allowed here so this
// module never pulls server-only code (db, clerk) into the client bundle.

export type Direction = 'in' | 'out';

/** Motivos shown when registering an Entrada (cash in). */
export type EntryMotivo = 'ajuste' | 'otro';

/** Motivos shown when registering a Salida (cash out). */
export type ExitMotivo
  = 'retiro_seguridad' | 'pago_gasto' | 'pago_proveedor' | 'otro';

/** Expense categories for "Pago de gasto" outflows. */
export type ExpenseCategory
  = | 'nomina'
    | 'servicios'
    | 'arriendo'
    | 'transporte'
    | 'marketing'
    | 'otros';

export const ENTRY_MOTIVOS: { value: EntryMotivo; label: string }[] = [
  { value: 'ajuste', label: 'Ajuste' },
  { value: 'otro', label: 'Otro' },
];

export const EXIT_MOTIVOS: { value: ExitMotivo; label: string }[] = [
  { value: 'retiro_seguridad', label: 'Retiro de seguridad' },
  { value: 'pago_gasto', label: 'Pago de gasto' },
  { value: 'pago_proveedor', label: 'Pago a proveedor' },
  { value: 'otro', label: 'Otro' },
];

export const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: 'nomina', label: 'Nómina' },
  { value: 'servicios', label: 'Servicios públicos' },
  { value: 'arriendo', label: 'Arriendo' },
  { value: 'transporte', label: 'Transporte' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'otros', label: 'Otros' },
];

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  EXPENSE_CATEGORIES.map(c => [c.value, c.label]),
);

export function categoryLabel(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return CATEGORY_LABEL[value] ?? value;
}

// ── Motivo (UI) → cash_movements.type (DB) ───────────────────────────────────
// The enum already encodes the finance semantics: adjustment/deposit raise cash
// (not revenue), withdrawal lowers cash but is NOT an expense, salary/expense
// are real expenses. See cash-helpers for the income/expense groupings.

export function entryTypeFor(motivo: EntryMotivo): CashMovementType {
  return motivo === 'ajuste' ? 'adjustment' : 'deposit';
}

export function exitTypeFor(
  motivo: ExitMotivo,
  category: ExpenseCategory | null,
): CashMovementType {
  if (motivo === 'retiro_seguridad') {
    return 'withdrawal';
  }
  if (motivo === 'pago_gasto') {
    return category === 'nomina' ? 'salary' : 'expense';
  }
  // Pago a proveedor is an operating expense (gasto operativo). The supplier link
  // lives on cash_movements.supplier_id, so reports can isolate supplier payments
  // by that FK — no separate financial record, single source of truth.
  if (motivo === 'pago_proveedor') {
    return 'expense';
  }
  // "Otro" salida — money left the drawer for an unspecified reason; treat it
  // as a generic expense (the dedicated non-expense case is retiro de seguridad).
  return 'expense';
}

// ── Activity-feed descriptors (also renders historical movements) ─────────────

type TypeMeta = { direction: Direction; label: string };

const TYPE_META: Record<CashMovementType, TypeMeta> = {
  sale: { direction: 'in', label: 'Venta en efectivo' },
  deposit: { direction: 'in', label: 'Entrada' },
  adjustment: { direction: 'in', label: 'Ajuste' },
  expense: { direction: 'out', label: 'Pago de gasto' },
  salary: { direction: 'out', label: 'Nómina' },
  inventory_purchase: { direction: 'out', label: 'Compra de inventario' },
  withdrawal: { direction: 'out', label: 'Retiro de seguridad' },
};

export function describeMovement(
  m: Pick<CashMovement, 'type' | 'category' | 'reason'>,
): { direction: Direction; title: string; detail: string | null } {
  const meta = TYPE_META[m.type] ?? {
    direction: 'out' as Direction,
    label: m.type,
  };
  const catLabel = categoryLabel(m.category);
  const title = m.type === 'expense' && catLabel ? catLabel : meta.label;
  const reason = m.reason?.trim();
  const detail
    = reason && reason.toLowerCase() !== title.toLowerCase() ? reason : null;
  return { direction: meta.direction, title, detail };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

const fmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function money(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value ?? 0;
  return fmt.format(Number.isFinite(n as number) ? (n as number) : 0);
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

/** Bank-app style relative time, e.g. "hace 5 minutos". */
export function relativeTime(value: Date | string | null | undefined): string {
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
    return 'Hace un momento';
  }
  if (abs < 3600) {
    return rtf.format(Math.round(diffSec / 60), 'minute');
  }
  if (abs < 86_400) {
    return rtf.format(Math.round(diffSec / 3600), 'hour');
  }
  return rtf.format(Math.round(diffSec / 86_400), 'day');
}

export const cashInputCls
  = 'flex h-11 w-full rounded-lg border border-input bg-card px-3 text-base outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&[type=number]]:[-moz-appearance:textfield]';
