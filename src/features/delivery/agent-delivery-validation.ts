/**
 * Agent-facing delivery create schema.
 *
 * Intentionally EXCLUDES price and stock fields — the LLM must NOT supply these.
 * The server re-fetches price + stock from db.forOrg at order time and discards
 * any caller-supplied value. This prevents price hallucination attacks.
 *
 * Contrast with deliveryCreateSchema (validation.ts) which accepts the full
 * snapshot including price (used by manual/POS callers who already know the price).
 * createDeliveryForOrg() stays unchanged — the agent route translates items into
 * the snapshot format before calling it.
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
    deliveryFee: z.number().nonnegative().max(1_000_000_000).default(0),
    notes: z.string().trim().max(1000).optional(),
    // n8n can supply the WhatsApp message id here for exactly-once creation.
    // The route deduplicates on (org, idempotencyKey) before inserting.
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();
