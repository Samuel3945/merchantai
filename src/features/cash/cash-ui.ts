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
export type EntryMotivo
  = | 'fondo_caja'
    | 'reposicion_caja_chica'
    | 'correccion_error'
    | 'aporte_capital'
    | 'otro';

/** Motivos shown when registering a Salida (cash out). */
export type ExitMotivo
  = | 'retiro_seguridad'
    | 'pago_proveedor'
    | 'gasto_menor'
    | 'devolucion_cliente'
    | 'vale_empleado'
    | 'otro';

/** Expense categories for "Pago de gasto" outflows. */
export type ExpenseCategory
  = | 'nomina'
    | 'servicios'
    | 'arriendo'
    | 'transporte'
    | 'marketing'
    | 'otros';

export const ENTRY_MOTIVOS: { value: EntryMotivo; label: string }[] = [
  { value: 'fondo_caja', label: 'Fondo de caja' },
  { value: 'reposicion_caja_chica', label: 'Reposición de caja chica' },
  { value: 'correccion_error', label: 'Corrección de error' },
  { value: 'aporte_capital', label: 'Aporte de capital' },
  { value: 'otro', label: 'Otro' },
];

export const EXIT_MOTIVOS: { value: ExitMotivo; label: string }[] = [
  { value: 'retiro_seguridad', label: 'Retiro de seguridad' },
  { value: 'pago_proveedor', label: 'Pago a proveedor' },
  { value: 'gasto_menor', label: 'Gasto menor' },
  { value: 'devolucion_cliente', label: 'Devolución a cliente' },
  { value: 'vale_empleado', label: 'Vale de empleado' },
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
  // Corrección de error is a reconciliation entry; every other entrada (fondo de
  // caja, reposición, aporte de capital, otro) is real cash coming in -> deposit.
  return motivo === 'correccion_error' ? 'adjustment' : 'deposit';
}

export function exitTypeFor(motivo: ExitMotivo): CashMovementType {
  if (motivo === 'retiro_seguridad') {
    // Relocates cash to a safe/bank — a salida, but NOT a P&L expense.
    return 'withdrawal';
  }
  if (motivo === 'vale_empleado') {
    // Employee advance: cash out + a receivable against future salary, not an
    // expense yet. Its own type so reports can isolate "vales empleados".
    return 'advance';
  }
  // Pago a proveedor, gasto menor, devolución a cliente y "otro" son gasto
  // operativo (expense). El proveedor se distingue por cash_movements.supplier_id,
  // no por una tabla aparte — una sola fuente de verdad.
  return 'expense';
}

// ── Activity-feed descriptors (also renders historical movements) ─────────────

type TypeMeta = { direction: Direction; label: string };

const TYPE_META: Record<CashMovementType, TypeMeta> = {
  sale: { direction: 'in', label: 'Venta en efectivo' },
  deposit: { direction: 'in', label: 'Entrada' },
  adjustment: { direction: 'in', label: 'Ajuste' },
  expense: { direction: 'out', label: 'Gasto' },
  salary: { direction: 'out', label: 'Nómina' },
  inventory_purchase: { direction: 'out', label: 'Compra de inventario' },
  withdrawal: { direction: 'out', label: 'Retiro de seguridad' },
  advance: { direction: 'out', label: 'Vale de empleado' },
  fiado_payment: { direction: 'in', label: 'Cobro de fiado' },
  reclassification: { direction: 'in', label: 'Reclasificación' },
};

export function describeMovement(
  m: Pick<CashMovement, 'type' | 'category' | 'reason'> & { amount?: string },
): { direction: Direction; title: string; detail: string | null } {
  const meta = TYPE_META[m.type] ?? {
    direction: 'out' as Direction,
    label: m.type,
  };
  // A reclassification is signed — its direction follows the amount (negative =
  // cash left the drawer because it was really a transfer).
  const direction: Direction
    = m.type === 'reclassification'
      ? (Number.parseFloat(m.amount ?? '0') || 0) < 0
          ? 'out'
          : 'in'
      : meta.direction;
  const catLabel = categoryLabel(m.category);
  const title = m.type === 'expense' && catLabel ? catLabel : meta.label;
  const reason = m.reason?.trim();
  const detail
    = reason && reason.toLowerCase() !== title.toLowerCase() ? reason : null;
  return { direction, title, detail };
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

const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'America/Bogota',
});

const stampFmt = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

/** yyyy-mm-dd in Bogota time — comparable lexicographically with a date input. */
export function dayKey(value: Date | string): string {
  return dayKeyFmt.format(new Date(value));
}

/** Full "09 jun 2026, 18:33" stamp in Bogota time for history tables. */
export function stamp(value: Date | string): string {
  return stampFmt.format(new Date(value));
}

/** Manual movements store a readable name; auto (sale) ones store a Clerk id. */
export function actorLabel(createdBy: string): string {
  return createdBy.startsWith('user_') ? 'Sistema' : createdBy;
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
