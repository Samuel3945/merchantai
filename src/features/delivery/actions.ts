'use server';

import type { DeliveryTransitionInput } from './validation';
import type { WhatsAppSendResult } from '@/libs/delivery-whatsapp';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { createSaleForOrg } from '@/actions/sales';
import { logAction } from '@/libs/audit-log';
import { isCashMethod } from '@/libs/cash-helpers';
import { isCreditoMethod } from '@/libs/creditos-math';
import { db } from '@/libs/DB';
import { sendWhatsAppTextForOrg } from '@/libs/delivery-whatsapp';
import { loadEInvoiceConfig } from '@/libs/einvoice/config';
import { emitInvoiceForSale } from '@/libs/einvoice/emit';
import { getCurrentPanelUser, requirePanelModule } from '@/libs/panel-session';
import {
  courierShiftsSchema,
  deliveryEventsSchema,
  deliveryOrdersSchema,
} from '@/models/Schema';
import {
  cancelReasonCustomerMessage,
  cancelReasonEventNote,
} from './cancellation-reasons';
import { settleDeliveryFee } from './settlement';
import { deliveryTransitionSchema } from './validation';

// Contraentrega default when the courier's deliver dialog sends no explicit
// method — keeps the historical behavior (efectivo → cash into the caja).
const DEFAULT_DELIVERY_PAYMENT = 'efectivo';

export type DeliveryOrder = typeof deliveryOrdersSchema.$inferSelect;
export type DeliveryEvent = typeof deliveryEventsSchema.$inferSelect;
export type DeliveryStatus = DeliveryOrder['status'];

// Statuses that still need courier action — the "active board" the courier sees
// by default. delivered/cancelled drop off the board into the history.
const ACTIVE_STATUSES: DeliveryStatus[] = ['pending', 'assigned', 'in_transit'];

// The state machine. Terminal states (delivered, cancelled) accept nothing — the
// order is closed. A cancellation can interrupt from any active state.
const ALLOWED_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  pending: ['assigned', 'in_transit', 'cancelled'],
  assigned: ['in_transit', 'delivered', 'cancelled'],
  in_transit: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

const LIST_LIMIT = 200;

export type DeliveryKpis = {
  active: number;
  inTransit: number;
  deliveredToday: number;
  feesToday: string;
};

// `status` scopes the board: 'active' (default) = pending+assigned+in_transit,
// 'all' = everything, or a single concrete status.
export async function listDeliveries(
  params?: { status?: DeliveryStatus | 'active' | 'all' },
): Promise<DeliveryOrder[]> {
  const { orgId } = await requirePanelModule('delivery');
  const scope = params?.status ?? 'active';

  const filters = [eq(deliveryOrdersSchema.organizationId, orgId)];
  if (scope === 'active') {
    filters.push(inArray(deliveryOrdersSchema.status, ACTIVE_STATUSES));
  } else if (scope !== 'all') {
    filters.push(eq(deliveryOrdersSchema.status, scope));
  }

  return db
    .select()
    .from(deliveryOrdersSchema)
    .where(and(...filters))
    .orderBy(desc(deliveryOrdersSchema.createdAt))
    .limit(LIST_LIMIT);
}

export async function getDeliveryKpis(): Promise<DeliveryKpis> {
  const { orgId } = await requirePanelModule('delivery');

  const [row] = await db
    .select({
      active: sql<number>`(COUNT(*) FILTER (WHERE ${deliveryOrdersSchema.status} IN ('pending','assigned','in_transit')))::int`,
      inTransit: sql<number>`(COUNT(*) FILTER (WHERE ${deliveryOrdersSchema.status} = 'in_transit'))::int`,
      deliveredToday: sql<number>`(COUNT(*) FILTER (WHERE ${deliveryOrdersSchema.status} = 'delivered' AND ${deliveryOrdersSchema.deliveredAt} >= date_trunc('day', now())))::int`,
      feesToday: sql<string>`COALESCE(SUM(${deliveryOrdersSchema.deliveryFee}) FILTER (WHERE ${deliveryOrdersSchema.status} = 'delivered' AND ${deliveryOrdersSchema.deliveredAt} >= date_trunc('day', now())), 0)::text`,
    })
    .from(deliveryOrdersSchema)
    .where(eq(deliveryOrdersSchema.organizationId, orgId));

  return {
    active: row?.active ?? 0,
    inTransit: row?.inTransit ?? 0,
    deliveredToday: row?.deliveredToday ?? 0,
    feesToday: row?.feesToday ?? '0',
  };
}

// The "Historial" timeline of one order: every event, oldest first.
export async function getDeliveryEvents(
  orderId: string,
): Promise<DeliveryEvent[]> {
  const { orgId } = await requirePanelModule('delivery');
  return db
    .select()
    .from(deliveryEventsSchema)
    .where(
      and(
        eq(deliveryEventsSchema.deliveryOrderId, orderId),
        eq(deliveryEventsSchema.organizationId, orgId),
      ),
    )
    .orderBy(asc(deliveryEventsSchema.createdAt));
}

// Shown when the courier tries to deliver without having started their shift
// (declared a caja). The delivered → cash-sale bridge has nowhere to book the
// money until they do.
const NO_ACTIVE_SHIFT_MESSAGE
  = 'Iniciá tu jornada y elegí una caja antes de entregar.';

// The courier's active shift (endedAt IS NULL) or null — just the fields
// transitionDelivery needs to route the delivered order's cash sale.
async function findActiveShift(
  orgId: string,
  courierId: string,
): Promise<{ id: string; posTokenId: string | null } | null> {
  const [shift] = await db
    .select({
      id: courierShiftsSchema.id,
      posTokenId: courierShiftsSchema.posTokenId,
    })
    .from(courierShiftsSchema)
    .where(
      and(
        eq(courierShiftsSchema.organizationId, orgId),
        eq(courierShiftsSchema.courierId, courierId),
        isNull(courierShiftsSchema.endedAt),
      ),
    )
    .limit(1);
  return shift ?? null;
}

// Translates a delivery order's item snapshot into POS sale lines. Every line
// MUST carry a productId: createSaleForOrg re-prices and decrements stock BY
// product, so a free-text line (legacy/manual, no productId) cannot become a
// correct sale. We THROW rather than silently drop it — the operator handles
// that order manually instead of the system booking a wrong sale.
function buildDeliverySaleItems(
  rawItems: DeliveryOrder['items'],
): { productId: string; qty: number }[] {
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (items.length === 0) {
    throw new Error(
      'Este pedido no tiene productos para facturar. Gestionalo manualmente.',
    );
  }
  return items.map((it) => {
    const productId = it?.productId;
    const qty = Number(it?.qty);
    if (typeof productId !== 'string' || productId.length === 0) {
      throw new Error(
        'Este pedido se creó antes de registrar el producto del catálogo, '
        + 'así que no puede facturarse automáticamente. Registrá la venta manualmente.',
      );
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(
        'Este pedido tiene una cantidad inválida. Gestionalo manualmente.',
      );
    }
    return { productId, qty };
  });
}

// What createDeliverySale hands back to transitionDelivery: the sale id to stamp
// on the order, plus the caja (device) the sale was booked into — the fee
// settlement (P2-B) needs the same session to keep the arqueo exact.
type DeliverySaleResult = {
  saleId: string | null;
  shiftPosTokenId: string | null;
};

// One entry of a mixed (split) contraentrega payment: a method NAME plus the
// amount collected with it. Mirrors the POS checkout's per-method breakdown.
type DeliveryPayment = { method: string; amount: number };

// Turns a delivered order into a POS sale in the courier's declared caja,
// returning the sale id to stamp on the order. Called BEFORE the status-flip tx
// (createSaleForOrg owns its OWN transaction — never nest it). Throws — leaving
// NO half state — when there is no active shift, when a line lacks a productId,
// or when the sale itself fails (e.g. a product was deleted). Idempotent for an
// already-delivered order (keeps the existing sale, creates nothing); the
// delivery order id, used as the sale idempotency key, is the second guard
// against double-selling.
//
// `paymentType` is the method the courier picked at delivery (P0-B). A credito
// method is rejected: a delivered contraentrega COLLECTS money into a caja, so a
// credit debt would defeat the settlement (and bypass the open-caja requirement).
async function createDeliverySale(
  deliveryOrderId: string,
  orgId: string,
  actor: Awaited<ReturnType<typeof getCurrentPanelUser>>,
  paymentType: string,
  payments?: DeliveryPayment[],
): Promise<DeliverySaleResult> {
  // Only a linked courier (pos_users row) with an active shift may deliver.
  if (!actor) {
    throw new Error(NO_ACTIVE_SHIFT_MESSAGE);
  }
  const shift = await findActiveShift(orgId, actor.id);
  if (!shift) {
    throw new Error(NO_ACTIVE_SHIFT_MESSAGE);
  }
  // Reject credito on either the single method or any split entry: a delivered
  // contraentrega COLLECTS money into a caja, so a credit debt makes no sense.
  if (
    isCreditoMethod(paymentType)
    || (payments?.some(p => isCreditoMethod(p.method)) ?? false)
  ) {
    throw new Error(
      'No se puede entregar a crédito. Elegí un método de cobro (efectivo, transferencia, etc.).',
    );
  }

  const [order] = await db
    .select()
    .from(deliveryOrdersSchema)
    .where(
      and(
        eq(deliveryOrdersSchema.id, deliveryOrderId),
        eq(deliveryOrdersSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!order) {
    throw new Error('Delivery order not found');
  }
  // Already delivered → idempotent: keep the existing sale, create nothing.
  if (order.status === 'delivered') {
    return { saleId: order.saleId ?? null, shiftPosTokenId: shift.posTokenId };
  }
  // Guard the state machine here too, so we never spend a createSaleForOrg on an
  // illegal transition (the status-flip tx re-checks it as defense in depth).
  if (!ALLOWED_TRANSITIONS[order.status].includes('delivered')) {
    throw new Error(
      `Transición no permitida: de "${order.status}" a "delivered"`,
    );
  }

  const items = buildDeliverySaleItems(order.items);

  // The courier's chosen method drives collection: a cash method (efectivo)
  // books into shift.posTokenId's open session via recordCashMovement; a digital
  // method flows through recordSaleTransferReconciliations — both inside
  // createSaleForOrg. Attributed to the courier (actorId = their pos_users id),
  // actorType 'api' like the other non-Clerk sale paths. The sale total is the
  // goods subtotal (createSaleForOrg re-prices from the catalog); the delivery
  // fee is settled separately (P2-B), never sold as a line here.
  // Split payment (pago mixto): book one sale_payments row per method. The
  // summary label mirrors the POS — the single method's name for one row,
  // 'Mixto' for several. createSaleForOrg re-prices from the catalog and already
  // iterates the breakdown for cash/transfer reconciliation.
  const hasSplit = payments != null && payments.length > 0;
  const summaryMethod = hasSplit
    ? (payments!.length === 1 ? payments![0]!.method : 'Mixto')
    : paymentType;

  const sale = await createSaleForOrg({
    orgId,
    actorId: actor.id,
    actorType: 'api',
    items,
    paymentType: summaryMethod,
    payments: hasSplit
      ? payments!.map(p => ({ method: p.method, amount: p.amount }))
      : undefined,
    posTokenId: shift.posTokenId,
    // The delivery order id (a UUID) IS the idempotency key. sale_idempotency_key
    // is a UUID column, so a "delivery:" prefix would break the insert; the raw
    // UUID keeps the (org, key) unique index as the second double-sell guard.
    idempotencyKey: deliveryOrderId,
  });

  return { saleId: sale.id, shiftPosTokenId: shift.posTokenId };
}

// Moves an order along the state machine, writing a status_change event to the
// ledger in the same transaction. Idempotent on the current status (returns it
// untouched) so a double-tap from the courier never errors or double-logs.
export async function transitionDelivery(
  id: string,
  input: DeliveryTransitionInput,
): Promise<DeliveryOrder> {
  const { userId, orgId } = await requirePanelModule('delivery');
  const parsed = deliveryTransitionSchema.parse(input);
  const { status: next, note } = parsed;

  // The method the courier picked at delivery (P0-B); default to contraentrega
  // cash so existing callers and the historical flow are unchanged.
  const paymentType
    = (parsed.paymentType && parsed.paymentType.trim()) || DEFAULT_DELIVERY_PAYMENT;

  // Mixed (split) breakdown, if the courier combined methods. Undefined = the
  // historical single-method path.
  const payments: DeliveryPayment[] | undefined = parsed.payments?.map(p => ({
    method: p.method,
    amount: p.amount,
  }));

  // Which method the fee settlement should treat the CASH cobro as. With a split,
  // only settle the fee as cash when the WHOLE collection was cash — if anything
  // was digital the fee's method is ambiguous, so we pass 'Mixto' (not cash) and
  // leave the fee for the arqueo. Understating the drawer is the accepted failure
  // model here (see settlement.ts); we never invent cash that may not be present.
  const feePaymentType
    = payments && payments.length > 0
      ? (payments.every(p => isCashMethod(p.method)) ? payments[0]!.method : 'Mixto')
      : paymentType;

  // P1: on a cancellation, the event note carries the chosen reason (+ free text
  // for 'otro') so the timeline explains WHY. Falls back to any free-form note.
  const eventNote
    = next === 'cancelled' && parsed.cancelReason
      ? cancelReasonEventNote(parsed.cancelReason, parsed.cancelReasonText)
      : note ?? null;

  // Who is acting: their pos_users row (linked to this Clerk identity). Used to
  // stamp the courier on an "assigned" claim, to personalize the customer
  // message, AND — for "delivered" — to find their active shift and attribute
  // the resulting cash sale. Null when there is no linked row (e.g. an owner
  // with no cashier row); the claim then falls back to the generic wording, and
  // a delivered attempt is rejected (a courier must be a real employee).
  const actor = next === 'assigned' || next === 'delivered'
    ? await getCurrentPanelUser(userId, orgId)
    : null;

  // DELIVERED is money-critical: the goods physically left, so the order becomes
  // a POS sale in the courier's declared caja. Resolve + create the sale BEFORE
  // flipping status — a failure (no shift, a free-text line, a vanished product)
  // aborts the transition and leaves NO half state.
  let deliveredSaleId: string | null = null;
  let deliverySale: DeliverySaleResult | null = null;
  if (next === 'delivered') {
    deliverySale = await createDeliverySale(id, orgId, actor, paymentType, payments);
    deliveredSaleId = deliverySale.saleId;
  }

  const updated = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(deliveryOrdersSchema)
      .where(
        and(
          eq(deliveryOrdersSchema.id, id),
          eq(deliveryOrdersSchema.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!current) {
      throw new Error('Delivery order not found');
    }
    if (current.status === next) {
      return current;
    }
    if (!ALLOWED_TRANSITIONS[current.status].includes(next)) {
      throw new Error(
        `Transición no permitida: de "${current.status}" a "${next}"`,
      );
    }

    const patch: Partial<typeof deliveryOrdersSchema.$inferInsert> = {
      status: next,
      updatedAt: new Date(),
    };
    const now = new Date();
    if (next === 'assigned') {
      patch.assignedAt = now;
      // Stamp the courier on the FIRST claim only — never overwrite a prior one.
      if (!current.courierId && actor) {
        patch.courierId = actor.id;
      }
    } else if (next === 'in_transit') {
      patch.inTransitAt = now;
    } else if (next === 'delivered') {
      patch.deliveredAt = now;
      // Link the cash sale created above (null only for a legacy order that was
      // already delivered — the same-status guard returns before this anyway).
      if (deliveredSaleId) {
        patch.saleId = deliveredSaleId;
      }
    } else if (next === 'cancelled') {
      patch.cancelledAt = now;
    }

    const [row] = await tx
      .update(deliveryOrdersSchema)
      .set(patch)
      .where(
        and(
          eq(deliveryOrdersSchema.id, id),
          eq(deliveryOrdersSchema.organizationId, orgId),
        ),
      )
      .returning();

    if (!row) {
      throw new Error('Delivery order not found');
    }

    await tx.insert(deliveryEventsSchema).values({
      deliveryOrderId: id,
      organizationId: orgId,
      type: 'status_change',
      fromStatus: current.status,
      toStatus: next,
      note: eventNote,
      actorType: 'user',
      createdBy: userId,
    });

    return row;
  });

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: `delivery.${next}`,
    entityType: 'delivery_order',
    entityId: updated.id,
    after: { id: updated.id, status: updated.status },
  });

  // Post-commit settlement for a delivered order (P2-A/P2-B). Everything here is
  // BEST-EFFORT and outside the transaction: the goods sale + status flip already
  // succeeded, so a fee/invoice hiccup must never surface as a failed delivery.
  if (next === 'delivered' && deliveredSaleId && deliverySale) {
    // P2-B: settle the delivery fee — 'revenue' books the cash into the same caja
    // session as the sale (arqueo stays exact); 'courier_tip' only notes it.
    await settleDeliveryFee({
      organizationId: orgId,
      deliveryOrderId: updated.id,
      saleId: deliveredSaleId,
      posTokenId: deliverySale.shiftPosTokenId,
      paymentType: feePaymentType,
      feeAmount: updated.deliveryFee,
      actorId: actor?.id ?? userId,
    }).catch(() => null);

    // P2-A: the courier asked for an electronic invoice — emit it on demand
    // (only when the org's e-invoicing is actually configured).
    if (parsed.wantsInvoice) {
      await maybeEmitDeliveryInvoice(orgId, deliveredSaleId);
    }
  }

  // L3 plugs in here: notify the customer over WhatsApp on each transition.
  // Kept outside the transaction on purpose — a messaging outage must never
  // roll back a real status change the courier already performed.
  await notifyCustomerOfTransition(
    updated,
    userId,
    actor?.name ?? null,
    next === 'cancelled' ? parsed.cancelReason ?? null : null,
  );

  revalidatePath('/dashboard/delivery');
  return updated;
}

// P2-A: best-effort electronic invoice for a delivered sale, requested EXPLICITLY
// by the courier via the deliver dialog. Unlike maybeAutoEmitInvoice (which only
// fires when the einvoice_auto flag is on), this emits on demand — but still ONLY
// when the org's e-invoicing is configured, and it NEVER blocks or fails the
// delivery. emitInvoiceForSale is idempotent (an already-emitted sale is a no-op)
// and consumes the credit itself, so a double call is safe.
async function maybeEmitDeliveryInvoice(
  orgId: string,
  saleId: string,
): Promise<void> {
  try {
    const cfg = await loadEInvoiceConfig(orgId);
    if (!cfg.configured) {
      return;
    }
    await emitInvoiceForSale(orgId, saleId, { actor: 'system' });
  } catch {
    // Best-effort: the sale already succeeded; the document stays retriable from
    // the Facturas module.
  }
}

// Generic "assigned" copy, used when we cannot resolve the courier's name.
const ASSIGNED_GENERIC = 'Tu pedido fue tomado por un domiciliario y saldrá pronto. 🛵';

// Customer-facing WhatsApp copy per transition. Cancellation and the in-transit
// / delivered moments are the ones worth a message. The 'assigned' entry is the
// generic fallback — see assignedMessage() for the personalized variant.
const STATUS_MESSAGES: Partial<Record<DeliveryStatus, string>> = {
  assigned: ASSIGNED_GENERIC,
  in_transit: '¡Tu pedido va en camino! 🛵 En breve llega a tu dirección.',
  delivered: '¡Tu pedido fue entregado! Gracias por tu compra. 🙌',
  cancelled: 'Tu pedido fue cancelado. Si tienes dudas, escríbenos por aquí.',
};

// Personalized "tomado por {name}" copy. Falls back to the generic wording when
// the courier's name could not be resolved.
function assignedMessage(courierName: string | null): string {
  return courierName
    ? `Tu pedido fue tomado por ${courierName} y saldrá pronto. 🛵`
    : ASSIGNED_GENERIC;
}

// Courier tool: ask the customer for the details needed to arrive (reference
// point, gate color, floor…). Sent over the org's own WhatsApp channel and
// recorded on the order timeline. Org-scoped and module-gated like every action
// here. Returns the send result so the UI can toast the outcome.
export async function requestAddressClarification(
  deliveryOrderId: string,
  extraText?: string,
): Promise<WhatsAppSendResult> {
  const { userId, orgId } = await requirePanelModule('delivery');

  const [order] = await db
    .select()
    .from(deliveryOrdersSchema)
    .where(
      and(
        eq(deliveryOrdersSchema.id, deliveryOrderId),
        eq(deliveryOrdersSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!order) {
    throw new Error('Delivery order not found');
  }

  const actor = await getCurrentPanelUser(userId, orgId);
  const intro = actor
    ? `Hola! Soy ${actor.name}, tu domiciliario 🛵.`
    : 'Hola! Soy tu domiciliario 🛵.';
  const extra = extraText?.trim().slice(0, 500);
  const message
    = `${intro} ¿Me pasás más detalles para llegar? (punto de referencia, color/portón de la casa, piso, etc.)${
      extra ? `\n\n${extra}` : ''
    }`;

  const result = await sendWhatsAppTextForOrg(orgId, order.customerPhone, message);

  if (result.sent) {
    await db.insert(deliveryEventsSchema).values({
      deliveryOrderId: order.id,
      organizationId: orgId,
      type: 'customer_notified',
      note: 'Aclaración de dirección solicitada',
      actorType: 'user',
      createdBy: userId,
    });
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'delivery.address_clarification_requested',
    entityType: 'delivery_order',
    entityId: order.id,
    after: { id: order.id, sent: result.sent },
  });

  revalidatePath('/dashboard/delivery');
  return result;
}

// L3: notify the customer over WhatsApp on each transition and record a
// `customer_notified` event when a message actually goes out. Best-effort and
// outside the transaction — a messaging outage must never roll back a real
// status change. Routed through the org's own WhatsApp channel. No-ops silently
// when WhatsApp is not configured or the org has no connected channel.
async function notifyCustomerOfTransition(
  order: DeliveryOrder,
  actorId: string,
  courierName: string | null,
  cancelReason: string | null,
): Promise<void> {
  // The cancelled copy DEPENDS on the reason (P1): the customer waiting for the
  // order gets a message that explains what happened, not a generic "cancelado".
  let message: string | undefined;
  if (order.status === 'assigned') {
    message = assignedMessage(courierName);
  } else if (order.status === 'cancelled') {
    message = cancelReason
      ? cancelReasonCustomerMessage(cancelReason)
      : STATUS_MESSAGES.cancelled;
  } else {
    message = STATUS_MESSAGES[order.status];
  }
  if (!message || !order.customerPhone) {
    return;
  }

  const result = await sendWhatsAppTextForOrg(
    order.organizationId,
    order.customerPhone,
    message,
  );
  if (!result.sent) {
    return;
  }

  await db.insert(deliveryEventsSchema).values({
    deliveryOrderId: order.id,
    organizationId: order.organizationId,
    type: 'customer_notified',
    toStatus: order.status,
    note: `WhatsApp enviado (${order.status})`,
    actorType: 'system',
    createdBy: actorId,
  });
}
