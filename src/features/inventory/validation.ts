import type { InventoryStatus, MovementReason } from '@/actions/inventory';
import { z } from 'zod';

// ── Reason catalogs ────────────────────────────────────────────────────────
// Selectable reasons per movement type. inventory_count is intentionally NOT
// selectable anymore (the Conteo flow is gone); 'spoiled' stays only in the
// label map for reading legacy history.

export type ReasonOption = { value: MovementReason; label: string };

export const EXIT_REASON_OPTIONS: ReasonOption[] = [
  { value: 'damaged', label: 'Se dañó o se rompió' },
  { value: 'expired', label: 'Se venció' },
  { value: 'lost', label: 'Se perdió o me lo robaron' },
  { value: 'consumption', label: 'Lo usé en el negocio' },
  { value: 'return_supplier', label: 'Se lo devolví al proveedor' },
  { value: 'manual', label: 'Otro motivo' },
];

export const ENTRY_REASON_OPTIONS: ReasonOption[] = [
  { value: 'purchase', label: 'Compra a proveedor' },
  { value: 'manual', label: 'Otro motivo' },
];

// Reasons offered in the history filter — includes the auto reasons (sale,
// return_sale) so the user can isolate, e.g., only sales-driven exits.
export const HISTORY_REASON_OPTIONS: ReasonOption[] = [
  { value: 'purchase', label: 'Compra a proveedor' },
  { value: 'sale', label: 'Venta' },
  { value: 'return_sale', label: 'Devolución de venta' },
  { value: 'damaged', label: 'Se dañó o se rompió' },
  { value: 'expired', label: 'Se venció' },
  { value: 'lost', label: 'Se perdió o me lo robaron' },
  { value: 'consumption', label: 'Lo usé en el negocio' },
  { value: 'return_supplier', label: 'Se lo devolví al proveedor' },
  { value: 'manual', label: 'Otro motivo' },
];

// Full label map, including legacy/auto reasons, for rendering the history.
export const REASON_LABELS: Record<string, string> = {
  purchase: 'Compra a proveedor',
  sale: 'Venta',
  return_sale: 'Devolución de venta',
  spoiled: 'Se venció',
  damaged: 'Se dañó o se rompió',
  expired: 'Se venció',
  lost: 'Se perdió o me lo robaron',
  consumption: 'Lo usé en el negocio',
  return_supplier: 'Se lo devolví al proveedor',
  manual: 'Otro motivo',
  inventory_count: 'Conteo físico',
};

// "Otro motivo" always requires a written explanation.
export function reasonRequiresNotes(reason: MovementReason): boolean {
  return reason === 'manual';
}

// ── Form schemas (shared by client guard + server intent) ──────────────────

const qty = z.coerce
  .number({ message: 'Cantidad inválida' })
  .positive('La cantidad debe ser mayor a 0');

const optionalMoney = z
  .string()
  .trim()
  .optional()
  .transform(v => (v || null));

export const entryFormSchema = z
  .object({
    qty,
    unitCost: optionalMoney,
    supplierId: z
      .string()
      .trim()
      .optional()
      .transform(v => (v || null)),
    expiresAt: z
      .string()
      .trim()
      .optional()
      .transform(v => (v || null)),
    reason: z.enum(['purchase', 'manual']),
    notes: z
      .string()
      .trim()
      .optional()
      .transform(v => (v || null)),
  })
  .superRefine((data, ctx) => {
    if (data.reason === 'manual' && !data.notes) {
      ctx.addIssue({
        code: 'custom',
        path: ['notes'],
        message: 'Describí el motivo',
      });
    }
  });

export const exitFormSchema = z
  .object({
    qty,
    reason: z.enum([
      'damaged',
      'expired',
      'lost',
      'consumption',
      'return_supplier',
      'manual',
    ]),
    notes: z
      .string()
      .trim()
      .optional()
      .transform(v => (v || null)),
  })
  .superRefine((data, ctx) => {
    if (data.reason === 'manual' && !data.notes) {
      ctx.addIssue({
        code: 'custom',
        path: ['notes'],
        message: 'Describí el motivo',
      });
    }
  });

// ── Status presentation (brand tokens, never raw colors) ───────────────────

export const STATUS_CONFIG: Record<
  InventoryStatus,
  { label: string; dot: string; text: string }
> = {
  ok: { label: 'OK', dot: 'bg-success', text: 'text-success' },
  low: { label: 'Bajo', dot: 'bg-warn', text: 'text-warn' },
  by_expiry: {
    label: 'Por vencer',
    dot: 'bg-terracotta',
    text: 'text-terracotta',
  },
  critical: { label: 'Agotado', dot: 'bg-destructive', text: 'text-destructive' },
};
