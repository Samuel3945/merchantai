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

// Per-type subsets for the history filter: when the user narrows to entries or
// exits, the reason list narrows too. 'manual' applies to both directions.
export const HISTORY_ENTRY_REASONS: ReasonOption[] = [
  { value: 'purchase', label: 'Compra a proveedor' },
  { value: 'return_sale', label: 'Devolución de venta' },
  { value: 'manual', label: 'Otro motivo' },
];

export const HISTORY_EXIT_REASONS: ReasonOption[] = [
  { value: 'sale', label: 'Venta' },
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

const requiredMoney = z
  .string()
  .trim()
  .min(1, 'El costo unitario es obligatorio')
  .refine(v => Number(v) > 0, 'El costo debe ser mayor a 0');

export const entryFormSchema = z
  .object({
    qty,
    // Every entry field is mandatory. Cost is always required; supplier and
    // expiry are required conditionally (purchase / perishable) below.
    unitCost: requiredMoney,
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
    // ── Pay-at-entry (REQ-3.x, S2-T3) — additive/optional, no breaking change ──
    // Only meaningful when reason === 'purchase'. Other entry types ignore these.
    paymentStatus: z
      .enum(['unpaid', 'full', 'partial'])
      .default('unpaid'),
    // Required and > 0 only when paymentStatus === 'partial'.
    paymentAmount: z
      .string()
      .trim()
      .optional()
      .transform(v => (v || null)),
    // UUID of the treasury container to debit. Required when paymentStatus is
    // 'full' or 'partial'.
    paymentAccountId: z
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
    if (data.reason === 'purchase' && !data.supplierId) {
      ctx.addIssue({
        code: 'custom',
        path: ['supplierId'],
        message: 'Elegí un proveedor',
      });
    }
    // Payment validation: full/partial require an account; partial requires amount.
    if (
      data.reason === 'purchase'
      && (data.paymentStatus === 'full' || data.paymentStatus === 'partial')
      && !data.paymentAccountId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['paymentAccountId'],
        message: 'Seleccioná el contenedor de donde sale el dinero',
      });
    }
    if (data.reason === 'purchase' && data.paymentStatus === 'partial') {
      const amt = Number(data.paymentAmount);
      const total = Number(data.qty) * Number(data.unitCost);
      if (!data.paymentAmount || amt <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['paymentAmount'],
          message: 'El monto parcial debe ser mayor a 0',
        });
      } else if (amt >= total) {
        ctx.addIssue({
          code: 'custom',
          path: ['paymentAmount'],
          message: 'El monto parcial debe ser menor al total (usá "Sí, pagué el total" para pago completo)',
        });
      }
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
    // Optional: when reason === 'return_supplier', the supplier whose payables
    // should be reduced. Omitting it keeps this a pure inventory exit (back-compat).
    supplierId: z
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
