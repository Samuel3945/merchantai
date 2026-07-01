import { tool } from 'ai';
import { z } from 'zod';
import { findOpenSession } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { createDeliveryForOrg } from './intake';

/**
 * AI SDK tool the WhatsApp assistant uses to push a parsed order into the
 * Domicilios board. Bound to a resolved `orgId` so the model never chooses the
 * tenant. The schema avoids transforms so its output type stays assignable to
 * the intake input.
 */
export function createDeliveryOrderTool(orgId: string) {
  return tool({
    description:
      'Crea un pedido a domicilio en el módulo Domicilios. Úsalo SOLO cuando el cliente haya confirmado su pedido y tengas la dirección de entrega.',
    inputSchema: z.object({
      customerName: z.string().nullish(),
      customerPhone: z.string().nullish(),
      address: z.string().min(1).describe('Dirección de entrega completa'),
      addressNotes: z.string().nullish().describe('Apto, referencias, portería'),
      items: z
        .array(
          z.object({
            name: z.string().min(1),
            qty: z.number().int().positive(),
            price: z.number().nonnegative(),
            // Optional: the LLM rarely resolves a catalog id from free text, so
            // these lines usually lack it and are handled manually at delivery
            // time. When present it flows into the snapshot like the API path.
            // `.optional()` (not nullish) to stay assignable to the intake
            // schema (deliveryItemSchema), which accepts undefined, not null.
            productId: z.string().uuid().optional(),
          }),
        )
        .default([]),
      deliveryFee: z.number().nonnegative().default(0),
      notes: z.string().nullish(),
    }),
    execute: async (input) => {
      try {
        // Open-caja guard (mirrors POST /api/agent/deliveries): a delivered order
        // becomes a POS sale booked into a caja, so the assistant must not TAKE
        // an order the business cannot settle. Any open session for the org
        // qualifies (WhatsApp is not tied to a physical till).
        const openCaja = await findOpenSession(db, orgId);
        if (!openCaja) {
          return {
            success: false,
            error: 'no_open_caja',
            message:
              'No hay una caja abierta. Pedile al comercio que abra la caja para tomar pedidos.',
          };
        }

        const order = await createDeliveryForOrg(orgId, input, {
          source: 'ai_agent',
          createdBy: 'ai_agent',
          actorType: 'api',
        });
        return { success: true, orderId: order.id, total: order.total };
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : 'create_failed',
        };
      }
    },
  });
}
