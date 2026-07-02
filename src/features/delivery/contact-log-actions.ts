'use server';

import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { getCurrentPanelUser, requirePanelModule } from '@/libs/panel-session';
import { deliveryEventsSchema, deliveryOrdersSchema } from '@/models/Schema';

// ── Courier contact logging ─────────────────────────────────────────────────
//
// Records when a courier TRIES to reach the customer (taps "Llamar", opens the
// in-app Chat, taps the wa.me WhatsApp link, or asks for an address
// clarification) — so the admin board can show who actually attempted contact
// and flag a `cancelled` delivery where NO contact was attempted at all.
//
// DESIGN: no new `delivery_event_type` enum value (an `ALTER TYPE ... ADD
// VALUE` is unsafe under transactional migrations and out of scope here).
// Instead this reuses the existing 'note' type with a structured marker in the
// `note` column: exactly 'contact:call' or 'contact:whatsapp'. listDeliveries
// (actions.ts) reduces these into `contactedCall` / `contactedWhatsapp` flags
// per order with one aggregate query.

export type DeliveryContactChannel = 'call' | 'whatsapp';

const CONTACT_NOTE: Record<DeliveryContactChannel, string> = {
  call: 'contact:call',
  whatsapp: 'contact:whatsapp',
};

/**
 * Fire-and-forget from the client — called without awaiting, errors swallowed
 * there. Never blocks the courier's actual `tel:`/wa.me navigation or the Chat
 * dialog opening. A duplicate call (e.g. the courier taps "Llamar" twice) is
 * accepted as-is: no dedup/idempotency guard beyond "don't crash" — the admin
 * indicator only checks "at least one contact event exists" so an extra row is
 * harmless.
 *
 * AUTHORIZATION — the SAME ownership gate as
 * delivery-chat-actions.ts#requireDeliveryChatAccess, inlined here rather than
 * imported/extracted (that file is out of scope for this change, owned by
 * other in-flight work): the caller must hold the `delivery` panel-module
 * grant (requirePanelModule — org:admin passes unconditionally), the order
 * must exist IN THIS ORG, and a non-admin caller may only log contact for an
 * order whose `courierId` is THEIR OWN resolved pos_users id. Do not weaken
 * this (e.g. do not drop the org-scope filter or allow any authenticated
 * panel user).
 */
export async function logDeliveryContact(
  orderId: string,
  channel: DeliveryContactChannel,
): Promise<{ success: boolean }> {
  const { userId, orgId } = await requirePanelModule('delivery');
  const { orgRole } = await auth();
  const isAdmin = orgRole === 'org:admin';

  const [order] = await db
    .select({
      id: deliveryOrdersSchema.id,
      courierId: deliveryOrdersSchema.courierId,
    })
    .from(deliveryOrdersSchema)
    .where(
      and(
        eq(deliveryOrdersSchema.id, orderId),
        eq(deliveryOrdersSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!order) {
    throw new Error('Pedido no encontrado');
  }

  const actor = await getCurrentPanelUser(userId, orgId);

  // Same ownership check as requireDeliveryChatAccess: admins bypass; a
  // non-admin must be the order's assigned courier (compared against the
  // server-resolved pos_users id, never a client-supplied one).
  if (!isAdmin && (!actor || order.courierId !== actor.id)) {
    throw new Error('No autorizado para contactar a este pedido.');
  }

  // Mirrors the insert shape used elsewhere in delivery_events (see
  // actions.ts#transitionDelivery / requestAddressClarification): actorType
  // 'user' + createdBy the Clerk userId — every panel action (courier or
  // admin) reaches here authenticated through Clerk, so 'user' is the same
  // actorType used for every other courier-originated event on this ledger.
  await db.insert(deliveryEventsSchema).values({
    deliveryOrderId: order.id,
    organizationId: orgId,
    type: 'note',
    note: CONTACT_NOTE[channel],
    actorType: 'user',
    createdBy: userId,
  });

  return { success: true };
}
