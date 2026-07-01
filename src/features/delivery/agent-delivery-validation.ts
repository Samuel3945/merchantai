/**
 * Agent-facing delivery create + quote schemas.
 *
 * Intentionally EXCLUDE price, stock AND deliveryFee — the LLM must NOT supply
 * any of these. The server re-fetches price + stock from db.forOrg at order
 * time and computes the delivery fee from the org's config (libs/delivery-fee.ts),
 * discarding any caller-supplied value. This prevents both price hallucination
 * and shipping-fee manipulation attacks.
 *
 * Contrast with deliveryCreateSchema (validation.ts) which accepts the full
 * snapshot including price and deliveryFee (used by manual/POS callers that
 * already know the price and had the fee computed for them by the same
 * libs/delivery-fee.ts helper). createDeliveryForOrg() stays unchanged — the
 * agent route translates items into the snapshot format before calling it.
 */
import { z } from 'zod';

export const agentDeliveryItemSchema = z
  .object({
    productId: z.string().uuid(),
    qty: z.number().int().positive().max(100000),
    // price and stock are NOT accepted — server re-fetches them.
  })
  .strict();

export const agentDeliveryCreateSchema = z
  .object({
    remoteJid: z.string().trim().min(1),
    // Optional customer FK — must belong to the same org (verified server-side).
    customerId: z.string().uuid().optional(),
    // Fallback phone if no customerId (no customer row required).
    phone: z.string().trim().max(50).optional(),
    items: z.array(agentDeliveryItemSchema).min(1),
    address: z.string().trim().min(1).max(500),
    addressNotes: z.string().trim().max(500).optional(),
    // deliveryFee is intentionally NOT accepted here — it is always computed
    // server-side from the org's delivery fee config. A caller-supplied
    // deliveryFee is rejected by .strict() below with a 400.
    notes: z.string().trim().max(1000).optional(),
    // n8n can supply the WhatsApp message id here for exactly-once creation.
    // The route deduplicates on (org, idempotencyKey) before inserting.
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * Agent-facing quote request — POST /api/agent/deliveries/quote.
 * Same item shape as agentDeliveryCreateSchema (no price/stock from the
 * caller); no address/customer fields since a quote never creates a row.
 */
export const agentDeliveryQuoteSchema = z
  .object({
    items: z.array(agentDeliveryItemSchema).min(1),
  })
  .strict();
