import { tool } from 'ai';
import { z } from 'zod';
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
          }),
        )
        .default([]),
      deliveryFee: z.number().nonnegative().default(0),
      notes: z.string().nullish(),
    }),
    execute: async (input) => {
      try {
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
