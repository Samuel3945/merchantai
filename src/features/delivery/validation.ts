import { z } from 'zod';
import { CANCEL_REASON_KEYS } from './cancellation-reasons';

// Reusable optional text field: trims, caps length, and normalizes empty/absent
// to null so the DB never stores empty strings.
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform(v => (v === '' || v === undefined ? null : v));
}

// A line the courier has to deliver. A snapshot, not a product FK, so the order
// always shows what was agreed even if the catalog changes later. `productId` is
// captured for agent/POS lines so a delivered order can become a real POS sale
// (stock + caja); manual free-text lines may omit it (handled manually then).
export const deliveryItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  qty: z.number().int().positive().max(100000),
  price: z.number().nonnegative().max(1_000_000_000),
  productId: z.string().uuid().optional(),
});

export const deliveryCreateSchema = z.object({
  customerName: optionalText(200),
  customerPhone: optionalText(50),
  address: z.string().trim().min(1).max(500),
  addressNotes: optionalText(500),
  items: z.array(deliveryItemSchema).default([]),
  deliveryFee: z.number().nonnegative().max(1_000_000_000).default(0),
  notes: optionalText(1000),
});

// The status state machine values. Kept here so client and server share one
// source of truth (the DB enum mirrors this list).
export const deliveryStatusValues = [
  'pending',
  'assigned',
  'in_transit',
  'delivered',
  'cancelled',
] as const;

export const deliveryTransitionSchema = z.object({
  status: z.enum(deliveryStatusValues),
  note: optionalText(500),
  // P0-B: the payment method the courier picks at delivery (a method NAME from
  // the org's real list, e.g. 'Efectivo' | 'Nequi'). Only meaningful for the
  // 'delivered' transition; the action defaults it to 'efectivo' when absent.
  paymentType: z.string().trim().min(1).max(100).nullable().optional(),
  // P2-A: the courier asked for an electronic invoice at delivery. Only honored
  // when the org actually has e-invoicing enabled (checked server-side).
  wantsInvoice: z.boolean().optional(),
  // P1: cancellation reason (a preset key) + optional free text (used for 'otro').
  // Only meaningful for the 'cancelled' transition.
  cancelReason: z.enum(CANCEL_REASON_KEYS).optional(),
  cancelReasonText: optionalText(500),
});

export type DeliveryCreateInput = z.input<typeof deliveryCreateSchema>;
export type DeliveryTransitionInput = z.input<typeof deliveryTransitionSchema>;
