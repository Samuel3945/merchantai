// Delivery-fee settlement (P2-B). The GOODS sale is created by createDeliverySale
// (goods subtotal only). The delivery fee (delivery_orders.delivery_fee) is money
// on TOP of the goods, and how it is handled depends on the org's fee mode:
//
//   'revenue'     — the fee is store income.
//                     - CASH (contraentrega efectivo): that physical cash lands
//                       in the same caja session as the sale, so we book a
//                       `deposit` cash_movement there to keep the arqueo exact
//                       (not short/over).
//                     - CREDITO (fiado): the customer didn't pay anything up
//                       front, so the fee is debt too — it bumps the credito's
//                       originalAmount (see addDeliveryFeeToCredito). A split
//                       payment reports paymentType 'Mixto', which is neither
//                       cash nor credito here, so it falls through to the
//                       arqueo-only default below (unchanged).
//                   We deliberately do NOT touch the goods sale's line items.
//   'courier_tip' — the fee belongs to the courier (paid a fixed wage). It is NOT
//                   store revenue and never enters the drawer; we only record a
//                   delivery_event note so it stays visible but separate.
//
// Everything here is BEST-EFFORT and runs AFTER the status-flip transaction
// commits: a failure must never roll back a delivery the courier already made.
// A dropped fee deposit/charge only understates the drawer/debt (reconciled at
// close, or simply owed less than it should) — the same acceptable failure
// model as recordCashMovement for the sale itself.

import { and, desc, eq, isNull } from 'drizzle-orm';
import { isCashMethod, toMoney } from '@/libs/cash-helpers';
import { isCreditoMethod, round2 } from '@/libs/creditos-math';
import { db } from '@/libs/DB';
import {
  appSettingsSchema,
  cashMovementsSchema,
  cashSessionsSchema,
  creditoMovementsSchema,
  creditosSchema,
  deliveryEventsSchema,
} from '@/models/Schema';

// The credito ledger note for the fee charge. Also the idempotency sentinel:
// a re-run (already-delivered idempotent path) never double-charges it.
const FEE_NOTE = 'Envío domicilio';

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

  // 'revenue': the fee is store income either way, but WHERE it lands depends
  // on how it was collected. Pure credito (fiado): nothing was paid up front,
  // so the fee is debt too — add it to the customer's balance. Note this only
  // fires for a PURE credito payment; a split sale reports paymentType
  // 'Mixto', which isCreditoMethod rejects, so it falls through to the
  // cash/arqueo branch below (correct — the credito portion of a mixed sale
  // is handled by the sale's own credito creation, not here).
  if (isCreditoMethod(args.paymentType)) {
    await addDeliveryFeeToCredito(args, fee);
    return;
  }

  // Only physical cash affects the arqueo. A non-cash, non-credito fee
  // (transfer, etc.) is store income too, but it never entered the drawer, so
  // there is nothing to reconcile here — it stays visible via the delivery KPIs.
  if (!isCashMethod(args.paymentType)) {
    return;
  }

  await recordFeeCashDeposit(args, fee);
}

// Adds the delivery fee to the customer's credito debt: bumps the credito's
// originalAmount (the balance is originalAmount - Σ(payment movements), see
// libs/creditos.ts#recordAbonoTx, so a charge movement alone would NOT move
// the balance) and records a `charge` movement for the ledger/audit trail.
// Deduped on (creditoId, type='charge', note=FEE_NOTE) so a re-run of this
// best-effort settlement never double-charges the fee.
async function addDeliveryFeeToCredito(
  args: SettleDeliveryFeeArgs,
  fee: number,
): Promise<void> {
  const [credito] = await db
    .select({ id: creditosSchema.id, originalAmount: creditosSchema.originalAmount })
    .from(creditosSchema)
    .where(
      and(
        eq(creditosSchema.organizationId, args.organizationId),
        eq(creditosSchema.saleId, args.saleId),
      ),
    )
    .limit(1);
  if (!credito) {
    // No credito for this sale — shouldn't happen for a credito delivery, but
    // there is nothing to add the fee to. Leave it (same best-effort model).
    return;
  }

  const [existing] = await db
    .select({ id: creditoMovementsSchema.id })
    .from(creditoMovementsSchema)
    .where(
      and(
        eq(creditoMovementsSchema.creditoId, credito.id),
        eq(creditoMovementsSchema.type, 'charge'),
        eq(creditoMovementsSchema.note, FEE_NOTE),
      ),
    )
    .limit(1);
  if (existing) {
    return;
  }

  const newOriginalAmount = round2(
    Number.parseFloat(credito.originalAmount) + fee,
  ).toFixed(2);

  await db.transaction(async (tx) => {
    await tx
      .update(creditosSchema)
      .set({ originalAmount: newOriginalAmount, updatedAt: new Date() })
      .where(
        and(
          eq(creditosSchema.id, credito.id),
          eq(creditosSchema.organizationId, args.organizationId),
        ),
      );

    await tx.insert(creditoMovementsSchema).values({
      creditoId: credito.id,
      organizationId: args.organizationId,
      type: 'charge',
      amount: toMoney(fee),
      note: FEE_NOTE,
      createdBy: args.actorId,
    });
  });
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
