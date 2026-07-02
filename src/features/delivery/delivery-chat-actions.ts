'use server';

import type { MessageRow } from '@/features/conversations/actions';
import { auth } from '@clerk/nextjs/server';
import { asc, desc, eq, like, or } from 'drizzle-orm';
import { PAUSE_MINUTES } from '@/features/conversations/status';
import { db } from '@/libs/db-context';
import { sendWhatsAppTextForOrg } from '@/libs/delivery-whatsapp';
import { getCurrentPanelUser, requirePanelModule } from '@/libs/panel-session';
import {
  conversationsSchema,
  deliveryOrdersSchema,
  messagesSchema,
} from '@/models/Schema';

// ─── Masked delivery chat (Option 1: reuse the customer's WhatsApp thread) ──
//
// A delivery is born from the WhatsApp bot, so the customer already has a
// `conversations` row keyed by their phone (`remoteJid`). Instead of a raw
// `wa.me` link that leaks the courier's personal number and logs nothing, the
// courier chats FROM THE APP through the business number, reusing that thread
// and the bot-pause takeover shipped for the admin inbox.
//
// SECURITY MODEL (enforced server-side on EVERY read and send):
//   1. requirePanelModule('delivery') — caller must hold the `delivery` grant
//      (admins pass unconditionally).
//   2. The order is loaded ORG-SCOPED (db.forOrg) — a cross-org id is "not
//      found", never leaks another tenant's order.
//   3. Ownership: a NON-ADMIN courier may only touch an order whose
//      `courierId` equals THEIR resolved pos_users id. Admins keep full access.
//   4. The conversation is DERIVED from the order's `customerPhone`, never
//      supplied by the client — so a courier can never point this at an
//      arbitrary conversation. The message read is scoped to that derived id.
// The client only ever holds a delivery order id it already owns; it never
// sends a conversationId.

const THREAD_LIMIT = 100;

// The thread + whether an in-app conversation exists at all. `conversationId`
// null → the customer has no WhatsApp thread yet (e.g. a manual order); the UI
// falls back to the existing `wa.me` affordance and shows no in-app thread.
export type DeliveryConversation = {
  conversationId: string | null;
  messages: MessageRow[];
};

function digitsOf(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

// Resolves the customer's conversation from the ORDER's phone, org-scoped. The
// remoteJid is stored as "573001234567@s.whatsapp.net" (or bare digits); the
// phone is normalized to digits and matched against its local part. Digits-only
// input carries no LIKE metacharacters, and drizzle binds it as a parameter.
// Returns the most recently active match, or null when the customer has no
// thread yet.
async function resolveConversationForPhone(
  orgId: string,
  customerPhone: string | null,
): Promise<{ id: string; remoteJid: string } | null> {
  const digits = digitsOf(customerPhone);
  if (!digits) {
    return null;
  }
  const [conv] = await db
    .forOrg(orgId)
    .select({
      id: conversationsSchema.id,
      remoteJid: conversationsSchema.remoteJid,
    })
    .from(conversationsSchema)
    .where(
      or(
        eq(conversationsSchema.remoteJid, digits),
        like(conversationsSchema.remoteJid, `${digits}@%`),
      ),
    )
    .orderBy(desc(conversationsSchema.lastMessageAt))
    .limit(1);
  return conv ?? null;
}

type DeliveryChatAccess = {
  userId: string;
  orgId: string;
  courierName: string;
  conversation: { id: string; remoteJid: string } | null;
};

// The single authorization gate every read/send routes through. Derives the
// conversation from an order the caller is proven to own — never from a
// client-supplied conversation id.
async function requireDeliveryChatAccess(
  deliveryOrderId: string,
): Promise<DeliveryChatAccess> {
  const { userId, orgId } = await requirePanelModule('delivery');
  const { orgRole } = await auth();
  const isAdmin = orgRole === 'org:admin';

  const [order] = await db
    .forOrg(orgId)
    .select({
      customerPhone: deliveryOrdersSchema.customerPhone,
      courierId: deliveryOrdersSchema.courierId,
    })
    .from(deliveryOrdersSchema)
    .where(eq(deliveryOrdersSchema.id, deliveryOrderId))
    .limit(1);

  if (!order) {
    throw new Error('Pedido no encontrado');
  }

  const actor = await getCurrentPanelUser(userId, orgId);

  // Delivery-ownership check: a courier may only chat about an order assigned to
  // THEM. Admins bypass (they own the whole board). We compare against the
  // server-resolved pos_users id, never a client-supplied courier id.
  if (!isAdmin && (!actor || order.courierId !== actor.id)) {
    throw new Error('No autorizado para chatear con este pedido.');
  }

  const courierName = actor?.name ?? 'Domiciliario';
  const conversation = await resolveConversationForPhone(orgId, order.customerPhone);

  return { userId, orgId, courierName, conversation };
}

/** Loads the customer's WhatsApp thread for a delivery the caller owns. */
export async function getDeliveryConversation(
  deliveryOrderId: string,
): Promise<DeliveryConversation> {
  const { orgId, conversation } = await requireDeliveryChatAccess(deliveryOrderId);
  if (!conversation) {
    return { conversationId: null, messages: [] };
  }

  const rows = await db
    .forOrg(orgId)
    .select({
      id: messagesSchema.id,
      direction: messagesSchema.direction,
      senderType: messagesSchema.senderType,
      body: messagesSchema.body,
      contentType: messagesSchema.contentType,
      createdAt: messagesSchema.createdAt,
    })
    .from(messagesSchema)
    .where(eq(messagesSchema.conversationId, conversation.id))
    .orderBy(asc(messagesSchema.createdAt))
    .limit(THREAD_LIMIT);

  return {
    conversationId: conversation.id,
    messages: rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })),
  };
}

/**
 * Sends a courier reply through the business WhatsApp number, reusing the
 * customer's existing thread. The outbound text is MASKED with `🛵 {courier}: `
 * so the customer knows a human courier is speaking — they only ever see the
 * business number, never the courier's personal one.
 *
 * Keeps the SAME bot-pause takeover semantics as the admin inbox
 * (sendConversationMessage): the send pauses the bot for PAUSE_MINUTES, stamps
 * who took over, and the bot auto-resumes on the next inbound message once the
 * window lapses. Inbound customer replies land back in this thread via the
 * WhatsApp webhook (n8n), unchanged.
 */
export async function sendDeliveryConversationMessage(
  deliveryOrderId: string,
  body: string,
): Promise<MessageRow> {
  const { userId, orgId, courierName, conversation }
    = await requireDeliveryChatAccess(deliveryOrderId);

  const text = body.trim();
  if (!text) {
    throw new Error('Escribí un mensaje para enviar');
  }
  if (!conversation) {
    throw new Error(
      'Este cliente todavía no tiene una conversación de WhatsApp. Usá el botón de WhatsApp.',
    );
  }

  // Masking + attribution: the customer sees a human courier, not the bot, and
  // never the courier's own number.
  const masked = `🛵 ${courierName}: ${text}`;

  // remoteJid looks like "573001234567@s.whatsapp.net"; strip the suffix so the
  // number goes through clean (sendWhatsAppTextForOrg re-normalizes anyway).
  const phone = conversation.remoteJid.split('@')[0] ?? conversation.remoteJid;

  const result = await sendWhatsAppTextForOrg(orgId, phone, masked);
  if (!result.sent) {
    throw new Error(
      result.skipped && result.reason === 'no_connected_channel'
        ? 'Conectá un WhatsApp del negocio para enviar mensajes.'
        : result.skipped
          ? 'WhatsApp no está configurado.'
          : 'No se pudo enviar el mensaje. Intentá de nuevo.',
    );
  }

  const [inserted] = await db
    .forOrg(orgId)
    .insert(messagesSchema)
    .values({
      conversationId: conversation.id,
      direction: 'outbound',
      senderType: 'human',
      senderId: userId,
      contentType: 'text',
      body: masked,
    })
    .returning({
      id: messagesSchema.id,
      direction: messagesSchema.direction,
      senderType: messagesSchema.senderType,
      body: messagesSchema.body,
      contentType: messagesSchema.contentType,
      createdAt: messagesSchema.createdAt,
    });

  if (!inserted) {
    throw new Error('El mensaje se envió pero no se pudo guardar en el historial');
  }

  // Auto-pause takeover — identical to the admin inbox's takeoverPatch: pause
  // the bot for PAUSE_MINUTES, stamp who took over, and bump lastMessageAt. The
  // bot auto-resumes on the next inbound message once the window elapses (see
  // POST /api/agent/conversations/upsert), so the thread is never left silent.
  const now = new Date();
  await db
    .forOrg(orgId)
    .update(conversationsSchema)
    .set({
      botPaused: true,
      botPausedUntil: new Date(now.getTime() + PAUSE_MINUTES * 60_000),
      botPausedBy: userId,
      attendedBy: userId,
      lastMessageAt: now,
      updatedAt: now,
    })
    .where(eq(conversationsSchema.id, conversation.id));

  return {
    id: inserted.id,
    direction: inserted.direction,
    senderType: inserted.senderType,
    body: inserted.body,
    contentType: inserted.contentType,
    createdAt: inserted.createdAt.toISOString(),
  };
}
