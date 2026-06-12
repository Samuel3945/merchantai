'use server';

import { createOpenAI } from '@ai-sdk/openai';
import { auth } from '@clerk/nextjs/server';
import { generateObject } from 'ai';
import { z } from 'zod';
import { getBusinessContext } from '@/libs/ai-context';
import { Env } from '@/libs/Env';
import { logger } from '@/libs/Logger';
import { resolveOrgOpenAiKey } from '@/libs/openai-key';

// Categorization is an AI-OWNED, always-on base feature: it never consumes an
// inteligentes credit. The key is resolved per-request with BYOK precedence — the
// org's own key (Settings › Integrations) if present, else the platform key
// (OPENAI_API_KEY). Either way the model assigns the category; the shop never
// types one by hand.
const CATEGORIZE_MODEL = 'gpt-4o-mini';

export type CategorizeResult
  = | {
    ok: true;
    category: string;
    attributes: { key: string; value: string }[];
  }
  | { ok: false; reason: 'unavailable' | 'too_short' };

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

// AI suggestion for a product's category + typical attributes. The category is
// biased by TWO stored signals so it fits THIS business:
//   1. the org's existing taxonomy (knownCategories) — reuse verbatim if one fits;
//   2. the inferred business context (libs/ai-context.ts) — the same energy drink
//      lands in a different category in a gym vs. a general store.
// No credit is consumed. Returns { ok: false, reason: 'unavailable' } when no key
// is configured or the model call fails — the caller leaves the field empty.
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

  const byokKey = await resolveOrgOpenAiKey(orgId);
  const apiKey = byokKey ?? Env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'unavailable' };
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

  // Inject the inferred business context so categories fit the kind of store.
  const businessContext = await getBusinessContext(orgId);
  const contextHint = businessContext
    ? ` El negocio es: ${businessContext}. Categoriza pensando en ese tipo de negocio.`
    : '';

  try {
    const openai = createOpenAI({ apiKey });
    const { object } = await generateObject({
      model: openai(CATEGORIZE_MODEL),
      schema: suggestionSchema,
      prompt: `Eres un asistente de catálogo para un negocio colombiano. Para el producto llamado "${trimmed}", sugiere una categoría comercial corta y hasta 6 características típicas (marca, tamaño, sabor, etc.). Responde en español. Si no puedes inferir un valor concreto para una característica, déjalo vacío.${contextHint}${taxonomyHint}`,
    });

    return {
      ok: true,
      category: object.category,
      attributes: object.attributes,
    };
  } catch (err) {
    logger.error('ai_categorize_failed', {
      organizationId: orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: 'unavailable' };
  }
}
