'use server';

import { anthropic } from '@ai-sdk/anthropic';
import { auth } from '@clerk/nextjs/server';
import { generateObject } from 'ai';
import { z } from 'zod';
import { consumeCredit } from '@/actions/plans';

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
export async function categorizeProduct(name: string): Promise<CategorizeResult> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    throw new Error('Not authenticated');
  }

  const trimmed = name.trim();
  if (trimmed.length < 3) {
    return { ok: false, reason: 'too_short' };
  }

  const credit = await consumeCredit('sales_manager');
  if (!credit.success) {
    return { ok: false, reason: 'no_credits' };
  }

  const { object } = await generateObject({
    model: anthropic('claude-haiku-4-5-20251001'),
    schema: suggestionSchema,
    prompt: `Eres un asistente de catálogo para un negocio colombiano. Para el producto llamado "${trimmed}", sugiere una categoría comercial corta y hasta 6 características típicas (marca, tamaño, sabor, etc.). Responde en español. Si no puedes inferir un valor concreto para una característica, déjalo vacío.`,
  });

  return {
    ok: true,
    category: object.category,
    attributes: object.attributes,
    remaining: credit.remaining,
  };
}
