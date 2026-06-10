'use server';

import { createOpenAI } from '@ai-sdk/openai';
import { auth } from '@clerk/nextjs/server';
import { generateObject } from 'ai';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { consumeCredit } from '@/actions/plans';
import { db } from '@/libs/DB';
import { Env } from '@/libs/Env';
import { appSettingsSchema } from '@/models/Schema';

// Categorization runs on OpenAI. The key is resolved per-request with BYOK
// precedence: if the org saved its own key in Settings › Integrations
// (`openai_api_key`), we use it and DON'T spend a platform credit. Otherwise we
// fall back to the platform key (OPENAI_API_KEY env) and consume one credit.
const CATEGORIZE_MODEL = 'gpt-4o-mini';

async function resolveOpenAiKey(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, orgId),
        eq(appSettingsSchema.key, 'openai_api_key'),
      ),
    )
    .limit(1);
  const byok = row?.value?.trim();
  return byok || null;
}

export type CategorizeResult
  = | {
    ok: true;
    category: string;
    attributes: { key: string; value: string }[];
    remaining: number;
  }
  | { ok: false; reason: 'no_credits' | 'too_short' };

const suggestionSchema = z.object({
  category: z
    .string()
    .describe('Categoría comercial corta en español, ej: "Bebidas", "Lácteos", "Aseo".'),
  attributes: z
    .array(
      z.object({
        key: z.string().describe('Nombre de la característica, ej: "Marca", "Tamaño".'),
        value: z.string().describe('Valor sugerido o cadena vacía si no se infiere.'),
      }),
    )
    .max(6)
    .describe('Características típicas para este tipo de producto.'),
});

// AI suggestion for a product's category + typical attributes, mirroring
// Tiendademo's "la IA categorizará este producto" behavior. Consumes one
// credit. NOTE: reuses the 'sales_manager' credit kind as an interim — a
// dedicated 'product_categorization' kind needs a usage_counters enum
// migration, tracked as a follow-up.
export async function categorizeProduct(
  name: string,
  knownCategories: string[] = [],
): Promise<CategorizeResult> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    throw new Error('Not authenticated');
  }

  const trimmed = name.trim();
  if (trimmed.length < 3) {
    return { ok: false, reason: 'too_short' };
  }

  const byokKey = await resolveOpenAiKey(orgId);
  const apiKey = byokKey ?? Env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'no_credits' };
  }

  // Platform key spends a credit; the org's own key (BYOK) bills their account.
  let remaining = Number.POSITIVE_INFINITY;
  if (!byokKey) {
    const credit = await consumeCredit('sales_manager');
    if (!credit.success) {
      return { ok: false, reason: 'no_credits' };
    }
    remaining = credit.remaining;
  }

  // Bias toward the business's own taxonomy: if one of its existing categories
  // fits, the model should reuse it verbatim instead of inventing a near-duplicate
  // ("Bebida" vs "Bebidas"). This is the deterministic-meets-LLM part of the
  // suggestion engine — the org's real categories steer the prompt.
  const existing = knownCategories
    .map(c => c.trim())
    .filter(Boolean)
    .slice(0, 30);
  const taxonomyHint
    = existing.length > 0
      ? ` El negocio ya usa estas categorías: ${existing.join(', ')}. Si alguna encaja con el producto, devuelve EXACTAMENTE esa (mismas mayúsculas y tildes); si ninguna encaja, propone una nueva.`
      : '';

  const openai = createOpenAI({ apiKey });
  const { object } = await generateObject({
    model: openai(CATEGORIZE_MODEL),
    schema: suggestionSchema,
    prompt: `Eres un asistente de catálogo para un negocio colombiano. Para el producto llamado "${trimmed}", sugiere una categoría comercial corta y hasta 6 características típicas (marca, tamaño, sabor, etc.). Responde en español. Si no puedes inferir un valor concreto para una característica, déjalo vacío.${taxonomyHint}`,
  });

  return {
    ok: true,
    category: object.category,
    attributes: object.attributes,
    remaining,
  };
}
