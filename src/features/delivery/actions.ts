'use server';

import type { DeliveryCreateInput, DeliveryTransitionInput } from './validation';
import { auth } from '@clerk/nextjs/server';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { sendWhatsAppText } from '@/libs/delivery-whatsapp';
import { deliveryEventsSchema, deliveryOrdersSchema } from '@/models/Schema';
import { createDeliveryForOrg } from './intake';
import { deliveryTransitionSchema } from './validation';

async function requireOrgId() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return { userId, orgId };
}

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
  const { orgId } = await requireOrgId();
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
  const { orgId } = await requireOrgId();

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
  const { orgId } = await requireOrgId();
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

export async function createDelivery(
  input: DeliveryCreateInput,
): Promise<DeliveryOrder> {
  const { userId, orgId } = await requireOrgId();
  return createDeliveryForOrg(orgId, input, {
    source: 'manual',
    createdBy: userId,
    actorType: 'user',
  });
}

// Moves an order along the state machine, writing a status_change event to the
// ledger in the same transaction. Idempotent on the current status (returns it
// untouched) so a double-tap from the courier never errors or double-logs.
export async function transitionDelivery(
  id: string,
  input: DeliveryTransitionInput,
): Promise<DeliveryOrder> {
  const { userId, orgId } = await requireOrgId();
  const { status: next, note } = deliveryTransitionSchema.parse(input);

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
    } else if (next === 'in_transit') {
      patch.inTransitAt = now;
    } else if (next === 'delivered') {
      patch.deliveredAt = now;
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
  await notifyCustomerOfTransition(updated, note ?? null, userId);

  revalidatePath('/dashboard/delivery');
  return updated;
}

// Customer-facing WhatsApp copy per transition. Cancellation and the in-transit
// / delivered moments are the ones worth a message.
const STATUS_MESSAGES: Partial<Record<DeliveryStatus, string>> = {
  assigned: 'Tu pedido fue tomado por un domiciliario y saldrá pronto. 🛵',
  in_transit: '¡Tu pedido va en camino! 🛵 En breve llega a tu dirección.',
  delivered: '¡Tu pedido fue entregado! Gracias por tu compra. 🙌',
  cancelled: 'Tu pedido fue cancelado. Si tienes dudas, escríbenos por aquí.',
};

// L3: notify the customer over WhatsApp on each transition and record a
// `customer_notified` event when a message actually goes out. Best-effort and
// outside the transaction — a messaging outage must never roll back a real
// status change. No-ops silently when WhatsApp is not configured.
async function notifyCustomerOfTransition(
  order: DeliveryOrder,
  _note: string | null,
  actorId: string,
): Promise<void> {
  const message = STATUS_MESSAGES[order.status];
  if (!message || !order.customerPhone) {
    return;
  }

  const result = await sendWhatsAppText(order.customerPhone, message);
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
