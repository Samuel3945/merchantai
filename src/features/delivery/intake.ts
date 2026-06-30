import type { DeliveryCreateInput } from './validation';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { deliveryEventsSchema, deliveryOrdersSchema } from '@/models/Schema';
import { deliveryCreateSchema } from './validation';

export type DeliveryOrderRow = typeof deliveryOrdersSchema.$inferSelect;

type CreateOpts = {
  source?: 'manual' | 'ai_agent' | 'pos';
  // Clerk user id (manual), or a synthetic id like 'ai_agent' for the assistant.
  createdBy?: string | null;
  // Drives the ledger/audit actor. 'user' for a panel admin, 'api' for the
  // WhatsApp agent, 'cashier' for the POS.
  actorType?: 'user' | 'cashier' | 'system' | 'api';
  // Caller-supplied key for exactly-once creation (e.g. WhatsApp message id).
  // Stored on the row; the partial-unique index on (org, key) enforces dedup.
  idempotencyKey?: string | null;
};

function computeTotals(
  items: { qty: number; price: number }[],
  fee: number,
): { subtotal: number; total: number } {
  const subtotal = items.reduce((sum, it) => sum + it.qty * it.price, 0);
  return { subtotal, total: subtotal + fee };
}

/**
 * Core delivery-order creation, decoupled from Clerk auth so it can run from a
 * server action (panel) OR from a request without a session (the WhatsApp
 * agent / Evolution webhook). The caller supplies the resolved `orgId`.
 */
export async function createDeliveryForOrg(
  orgId: string,
  input: DeliveryCreateInput,
  opts: CreateOpts = {},
): Promise<DeliveryOrderRow> {
  const data = deliveryCreateSchema.parse(input);
  const source = opts.source ?? 'manual';
  const actorType = opts.actorType ?? 'user';
  const createdBy = opts.createdBy ?? null;
  const idempotencyKey = opts.idempotencyKey ?? null;
  const { subtotal, total } = computeTotals(data.items, data.deliveryFee);

  const order = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(deliveryOrdersSchema)
      .values({
        organizationId: orgId,
        customerName: data.customerName ?? null,
        customerPhone: data.customerPhone ?? null,
        address: data.address,
        addressNotes: data.addressNotes ?? null,
        items: data.items,
        subtotal: subtotal.toFixed(2),
        deliveryFee: data.deliveryFee.toFixed(2),
        total: total.toFixed(2),
        source,
        notes: data.notes ?? null,
        createdBy,
        idempotencyKey,
      })
      .returning();

    if (!created) {
      throw new Error('Failed to create delivery order');
    }

    await tx.insert(deliveryEventsSchema).values({
      deliveryOrderId: created.id,
      organizationId: orgId,
      type: 'created',
      toStatus: 'pending',
      actorType,
      createdBy,
    });

    return created;
  });

  await logAction({
    organizationId: orgId,
    actor: { type: actorType, id: createdBy ?? 'system' },
    action: 'delivery.created',
    entityType: 'delivery_order',
    entityId: order.id,
    after: { id: order.id, address: order.address, total: order.total, source },
  });

  revalidatePath('/dashboard/delivery');
  return order;
}
