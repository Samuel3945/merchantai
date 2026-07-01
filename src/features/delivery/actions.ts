'use server';

import type { DeliveryTransitionInput } from './validation';
import type { WhatsAppSendResult } from '@/libs/delivery-whatsapp';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { createSaleForOrg } from '@/actions/sales';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { sendWhatsAppTextForOrg } from '@/libs/delivery-whatsapp';
import { getCurrentPanelUser, requirePanelModule } from '@/libs/panel-session';
import {
  courierShiftsSchema,
  deliveryEventsSchema,
  deliveryOrdersSchema,
} from '@/models/Schema';
import { deliveryTransitionSchema } from './validation';

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

// Turns a delivered order into a cash POS sale in the courier's declared caja,
// returning the sale id to stamp on the order. Called BEFORE the status-flip tx
// (createSaleForOrg owns its OWN transaction — never nest it). Throws — leaving
// NO half state — when there is no active shift, when a line lacks a productId,
// or when the sale itself fails (e.g. a product was deleted). Idempotent for an
// already-delivered order (keeps the existing sale, creates nothing); the
// `delivery:<id>` idempotency key is the second guard against double-selling.
async function createDeliverySale(
  deliveryOrderId: string,
  orgId: string,
  actor: Awaited<ReturnType<typeof getCurrentPanelUser>>,
): Promise<string | null> {
  // Only a linked courier (pos_users row) with an active shift may deliver.
  if (!actor) {
    throw new Error(NO_ACTIVE_SHIFT_MESSAGE);
  }
  const shift = await findActiveShift(orgId, actor.id);
  if (!shift) {
    throw new Error(NO_ACTIVE_SHIFT_MESSAGE);
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
    return order.saleId ?? null;
  }
  // Guard the state machine here too, so we never spend a createSaleForOrg on an
  // illegal transition (the status-flip tx re-checks it as defense in depth).
  if (!ALLOWED_TRANSITIONS[order.status].includes('delivered')) {
    throw new Error(
      `Transición no permitida: de "${order.status}" a "delivered"`,
    );
  }

  const items = buildDeliverySaleItems(order.items);

  // Contraentrega (COD): the courier collects cash, so paymentType 'efectivo' —
  // createSaleForOrg's recordCashMovement books it into shift.posTokenId's open
  // session (null = the admin/dashboard caja). Attributed to the courier
  // (actorId = their pos_users id), actorType 'api' like the other non-Clerk
  // sale paths. The sale total is the goods subtotal (createSaleForOrg re-prices
  // from the catalog); the delivery fee is tracked separately, not sold here.
  const sale = await createSaleForOrg({
    orgId,
    actorId: actor.id,
    actorType: 'api',
    items,
    paymentType: 'efectivo',
    posTokenId: shift.posTokenId,
    idempotencyKey: `delivery:${deliveryOrderId}`,
  });

  return sale.id;
}

// Moves an order along the state machine, writing a status_change event to the
// ledger in the same transaction. Idempotent on the current status (returns it
// untouched) so a double-tap from the courier never errors or double-logs.
export async function transitionDelivery(
  id: string,
  input: DeliveryTransitionInput,
): Promise<DeliveryOrder> {
  const { userId, orgId } = await requirePanelModule('delivery');
  const { status: next, note } = deliveryTransitionSchema.parse(input);

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
  // a cash sale in the courier's declared caja. Resolve + create the sale BEFORE
  // flipping status — a failure (no shift, a free-text line, a vanished product)
  // aborts the transition and leaves NO half state.
  let deliveredSaleId: string | null = null;
  if (next === 'delivered') {
    deliveredSaleId = await createDeliverySale(id, orgId, actor);
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
      note: note ?? null,
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

  // L3 plugs in here: notify the customer over WhatsApp on each transition.
  // Kept outside the transaction on purpose — a messaging outage must never
  // roll back a real status change the courier already performed.
  await notifyCustomerOfTransition(updated, note ?? null, userId, actor?.name ?? null);

  revalidatePath('/dashboard/delivery');
  return updated;
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
  _note: string | null,
  actorId: string,
  courierName: string | null,
): Promise<void> {
  const message = order.status === 'assigned'
    ? assignedMessage(courierName)
    : STATUS_MESSAGES[order.status];
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
