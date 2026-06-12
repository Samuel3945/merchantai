// Layer 3 — automatic re-categorization on a business-context shift.
//
// When libs/ai-context.ts detects the store changed character (e.g. a gym that
// starts selling groceries), the WHOLE catalog is re-evaluated against the new
// context so categories stay coherent — the same energy drink moves out of
// "Suplementos" and into "Bebidas" once the place reads as a general store.
//
// Cost control: products are sent to the model in chunks (one call per CHUNK,
// not one per product), and only products whose category actually changes are
// written. This is invoked only on a real signature shift, which is rare. It
// swallows its own errors — a failed pass must never break the Products page.
//
// NOTE: synchronous and capped at MAX_PRODUCTS. For the target audience (small
// shops) a full pass is a handful of calls. A larger catalog should move this to
// a background job — tracked as a follow-up.

import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/libs/DB';
import { Env } from '@/libs/Env';
import { logger } from '@/libs/Logger';
import { resolveOrgOpenAiKey } from '@/libs/openai-key';
import { categoriesSchema, productsSchema } from '@/models/Schema';
import { refreshCategory, upsertCategory } from './categories-db';

const MODEL = 'gpt-4o-mini';
const CHUNK = 50;
const MAX_PRODUCTS = 600;

const batchSchema = z.object({
  items: z
    .array(
      z.object({
        index: z.number().int(),
        category: z
          .string()
          .describe('Categoría comercial corta en español para ese producto.'),
      }),
    )
    .describe('Una entrada por producto, identificada por su índice.'),
});

type ProductLite = {
  id: string;
  name: string;
  category: string | null;
};

// One model call for up to CHUNK products. Returns index → category. Returns an
// empty map on any failure so the caller skips this chunk without aborting.
async function categorizeChunk(
  openai: ReturnType<typeof createOpenAI>,
  context: string,
  taxonomy: string[],
  chunk: ProductLite[],
): Promise<Map<number, string>> {
  const taxonomyHint
    = taxonomy.length > 0
      ? ` Categorías que ya usa el negocio: ${taxonomy.join(', ')}. Reutiliza EXACTAMENTE una de estas si encaja; si no, propone una nueva corta.`
      : '';
  const list = chunk.map((p, i) => `${i}: ${p.name}`).join('\n');

  try {
    const { object } = await generateObject({
      model: openai(MODEL),
      schema: batchSchema,
      prompt:
        `Eres un asistente de catálogo para un negocio colombiano. El negocio es: `
        + `${context}. Categoriza cada producto de la lista pensando en ese tipo `
        + `de negocio: asigna una categoría comercial corta en español por `
        + `producto.${taxonomyHint}\nLista (índice: nombre):\n${list}`,
    });
    const map = new Map<number, string>();
    for (const item of object.items) {
      const cat = item.category.trim();
      if (cat && item.index >= 0 && item.index < chunk.length) {
        map.set(item.index, cat);
      }
    }
    return map;
  } catch (err) {
    logger.error('recategorize_chunk_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

// Re-categorizes the org's catalog against `context`. Returns how many products
// changed category. Never throws.
export async function recategorizeForContext(
  orgId: string,
  context: string,
): Promise<{ updated: number }> {
  try {
    const apiKey = (await resolveOrgOpenAiKey(orgId)) ?? Env.OPENAI_API_KEY;
    if (!apiKey) {
      return { updated: 0 };
    }

    const products = await db
      .select({
        id: productsSchema.id,
        name: productsSchema.name,
        category: productsSchema.category,
        categoryId: productsSchema.categoryId,
      })
      .from(productsSchema)
      .where(
        and(
          eq(productsSchema.organizationId, orgId),
          eq(productsSchema.deleted, false),
        ),
      )
      .orderBy(desc(productsSchema.createdAt))
      .limit(MAX_PRODUCTS);

    if (products.length === 0) {
      return { updated: 0 };
    }

    const cats = await db
      .select({ name: categoriesSchema.name })
      .from(categoriesSchema)
      .where(eq(categoriesSchema.organizationId, orgId))
      .orderBy(desc(categoriesSchema.usageCount))
      .limit(40);
    const taxonomy = cats.map(c => c.name).filter(Boolean);

    const openai = createOpenAI({ apiKey });
    const affected = new Set<string>();
    let updated = 0;

    for (let start = 0; start < products.length; start += CHUNK) {
      const chunk = products.slice(start, start + CHUNK);
      const assignments = await categorizeChunk(
        openai,
        context,
        taxonomy,
        chunk,
      );

      const changes: { product: (typeof chunk)[number]; newCat: string }[] = [];
      chunk.forEach((product, i) => {
        const newCat = assignments.get(i);
        if (!newCat) {
          return;
        }
        // Idempotent: skip products already in the right category (slug compare).
        if ((product.category ?? '').trim().toLowerCase() === newCat.toLowerCase()) {
          return;
        }
        changes.push({ product, newCat });
      });

      if (changes.length === 0) {
        continue;
      }

      await db.transaction(async (tx) => {
        for (const { product, newCat } of changes) {
          const newCategoryId = await upsertCategory(tx, orgId, newCat, 'ai');
          await tx
            .update(productsSchema)
            .set({ category: newCat, categoryId: newCategoryId })
            .where(
              and(
                eq(productsSchema.id, product.id),
                eq(productsSchema.organizationId, orgId),
              ),
            );
          if (product.categoryId) {
            affected.add(product.categoryId);
          }
          affected.add(newCategoryId);
          updated += 1;
        }
      });
    }

    // Recompute usage/template stats for every category that gained or lost
    // products, so the dynamic taxonomy stays in sync.
    if (affected.size > 0) {
      await db.transaction(async (tx) => {
        for (const categoryId of affected) {
          await refreshCategory(tx, orgId, categoryId);
        }
      });
    }

    if (products.length >= MAX_PRODUCTS) {
      logger.warn('recategorize_capped', {
        organizationId: orgId,
        cap: MAX_PRODUCTS,
      });
    }

    return { updated };
  } catch (err) {
    logger.error('recategorize_failed', {
      organizationId: orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { updated: 0 };
  }
}
