// Delivery-fee settlement (P2-B). The GOODS sale is created by createDeliverySale
// (goods subtotal only). The delivery fee (delivery_orders.delivery_fee) is money
// on TOP of the goods, and how it is handled depends on the org's fee mode:
//
//   'revenue'     — the fee is store income. When the courier collected it in
//                   CASH (contraentrega efectivo), that physical cash lands in the
//                   same caja session as the sale, so we book a `deposit`
//                   cash_movement there to keep the arqueo exact (not short/over).
//                   We deliberately do NOT touch the goods sale's line items.
//   'courier_tip' — the fee belongs to the courier (paid a fixed wage). It is NOT
//                   store revenue and never enters the drawer; we only record a
//                   delivery_event note so it stays visible but separate.
//
// Everything here is BEST-EFFORT and runs AFTER the status-flip transaction
// commits: a failure must never roll back a delivery the courier already made.
// A dropped fee deposit only understates the drawer (reconciled at close) — the
// same acceptable failure model as recordCashMovement for the sale itself.

import { and, desc, eq, isNull } from 'drizzle-orm';
import { isCashMethod, toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import {
  appSettingsSchema,
  cashMovementsSchema,
  cashSessionsSchema,
  deliveryEventsSchema,
} from '@/models/Schema';

export const DELIVERY_FEE_MODE_KEY = 'delivery_fee_mode';

export type DeliveryFeeMode = 'revenue' | 'courier_tip';

export const DEFAULT_DELIVERY_FEE_MODE: DeliveryFeeMode = 'revenue';

// Marks the delivery_event note that records a courier tip, so the settlement is
// idempotent (we never write two tip notes for the same order).
const COURIER_TIP_NOTE_PREFIX = 'Propina domiciliario';

const cop = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export async function loadDeliveryFeeMode(
  organizationId: string,
): Promise<DeliveryFeeMode> {
  const [row] = await db
    .select({ value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, organizationId),
        eq(appSettingsSchema.key, DELIVERY_FEE_MODE_KEY),
      ),
    )
    .limit(1);
  return row?.value === 'courier_tip' ? 'courier_tip' : DEFAULT_DELIVERY_FEE_MODE;
}

export type SettleDeliveryFeeArgs = {
  organizationId: string;
  deliveryOrderId: string;
  // The goods sale created for this delivery — the cash-deposit dedup sentinel.
  saleId: string;
  // The caja (device) the sale was booked into; null = admin/dashboard caja.
  posTokenId: string | null;
  // The payment method chosen at delivery (method name). Decides cash vs digital.
  paymentType: string;
  // delivery_orders.delivery_fee (numeric string or number).
  feeAmount: number | string;
  // pos_users id of the courier (or the acting user) for the created_by trail.
  actorId: string;
};

// Settles the delivery fee according to the org's fee mode. Idempotent and
// best-effort; callers should `.catch(() => null)` and never await it into a
// user-facing failure that could imply the delivery itself failed.
export async function settleDeliveryFee(
  args: SettleDeliveryFeeArgs,
): Promise<void> {
  const fee = typeof args.feeAmount === 'string'
    ? Number.parseFloat(args.feeAmount)
    : args.feeAmount;
  if (!Number.isFinite(fee) || fee <= 0) {
    return;
  }

  const mode = await loadDeliveryFeeMode(args.organizationId);

  if (mode === 'courier_tip') {
    await recordCourierTip(args, fee);
    return;
  }

  // 'revenue': only physical cash affects the arqueo. A non-cash fee (transfer,
  // etc.) is store income too, but it never entered the drawer, so there is
  // nothing to reconcile here — it stays visible via the delivery KPIs.
  if (!isCashMethod(args.paymentType)) {
    return;
  }

  await recordFeeCashDeposit(args, fee);
}

// Books the cash fee as a `deposit` cash_movement into the sale's own caja
// session, so the expected drawer amount includes it. Deduped on the sale id so
// a re-run (idempotent already-delivered path) never double-counts it.
async function recordFeeCashDeposit(
  args: SettleDeliveryFeeArgs,
  fee: number,
): Promise<void> {
  const [existing] = await db
    .select({ id: cashMovementsSchema.id })
    .from(cashMovementsSchema)
    .where(
      and(
        eq(cashMovementsSchema.organizationId, args.organizationId),
        eq(cashMovementsSchema.saleId, args.saleId),
        eq(cashMovementsSchema.type, 'deposit'),
      ),
    )
    .limit(1);
  if (existing) {
    return;
  }

  // Book into the SAME session the sale landed in: the open session scoped to
  // the shift's device (null = admin/dashboard caja), most-recently-opened. If
  // none is open we skip rather than auto-open the wrong window — the fee is
  // left for the arqueo, never credited to a stray session. Explicit projection
  // (id only) mirrors /api/agent/orders' own open-session lookup.
  const [session] = await db
    .select({ id: cashSessionsSchema.id })
    .from(cashSessionsSchema)
    .where(
      and(
        eq(cashSessionsSchema.organizationId, args.organizationId),
        eq(cashSessionsSchema.status, 'open'),
        args.posTokenId === null
          ? isNull(cashSessionsSchema.posTokenId)
          : eq(cashSessionsSchema.posTokenId, args.posTokenId),
      ),
    )
    .orderBy(desc(cashSessionsSchema.openedAt))
    .limit(1);
  if (!session) {
    return;
  }

  await db.insert(cashMovementsSchema).values({
    sessionId: session.id,
    organizationId: args.organizationId,
    type: 'deposit',
    amount: toMoney(fee),
    reason: 'Cobro de domicilio',
    createdBy: args.actorId,
    saleId: args.saleId,
  });
}

// Records the fee as a courier tip on the order timeline: visible, but NOT store
// revenue and NOT in the caja. Deduped by scanning for an existing tip note.
async function recordCourierTip(
  args: SettleDeliveryFeeArgs,
  fee: number,
): Promise<void> {
  const existing = await db
    .select({ id: deliveryEventsSchema.id, note: deliveryEventsSchema.note })
    .from(deliveryEventsSchema)
    .where(
      and(
        eq(deliveryEventsSchema.deliveryOrderId, args.deliveryOrderId),
        eq(deliveryEventsSchema.type, 'note'),
      ),
    );
  if (existing.some(e => e.note?.startsWith(COURIER_TIP_NOTE_PREFIX))) {
    return;
  }

  await db.insert(deliveryEventsSchema).values({
    deliveryOrderId: args.deliveryOrderId,
    organizationId: args.organizationId,
    type: 'note',
    note: `${COURIER_TIP_NOTE_PREFIX}: ${cop.format(fee)}`,
    actorType: 'system',
    createdBy: args.actorId,
  });
}
