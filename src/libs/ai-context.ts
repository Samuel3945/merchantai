// Business-context inference — the "what KIND of store is this" layer that
// powers context-aware product categorization (see features/products/
// ai-categorize.ts and features/products/recategorize.ts).
//
// Two-speed design, on purpose:
//   1. A DETERMINISTIC signature (buildContextSignature) is computed from the
//      stable shape of the catalog. It's free and runs on every Products load.
//   2. The EXPENSIVE LLM inference (inferBusinessContext) only fires when that
//      signature shifts — i.e. when the business genuinely changed character
//      (a gym that starts stocking groceries), not on every product edit.
//
// This is what makes the taxonomy "dynamic by store context" affordable: OpenAI
// is hit on real shifts, never on routine activity. The inference does NOT spend
// an inteligentes credit — it bills the platform/BYOK key directly, as a base
// feature.

import { createHash } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/libs/DB';
import { Env } from '@/libs/Env';
import { logger } from '@/libs/Logger';
import { resolveOrgOpenAiKey } from '@/libs/openai-key';
import { businessProfileSchema } from '@/models/Schema';

const CONTEXT_MODEL = 'gpt-4o-mini';

// Bucket the catalog size so adding a single product never shifts the signature
// — only crossing an order-of-magnitude boundary does.
function sizeBucket(n: number): string {
  if (n <= 0) {
    return '0';
  }
  if (n <= 10) {
    return 'xs';
  }
  if (n <= 30) {
    return 's';
  }
  if (n <= 100) {
    return 'm';
  }
  if (n <= 300) {
    return 'l';
  }
  return 'xl';
}

type ContextSignals = {
  inferredBusinessType: string | null;
  productCount: number;
  topCategoryNames: string[];
};

// Deterministic fingerprint of the *stable* shape of the business. Two catalogs
// with the same dominant categories, scale bucket and coarse type hash equal, so
// the LLM inference only re-runs when the business REALLY shifts.
function buildContextSignature(s: ContextSignals): string {
  const cats = s.topCategoryNames
    .map(c => c.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  const payload = JSON.stringify({
    type: s.inferredBusinessType ?? 'none',
    size: sizeBucket(s.productCount),
    cats,
  });
  return createHash('sha1').update(payload).digest('hex');
}

const contextSchema = z.object({
  context: z
    .string()
    .describe(
      'Tipo de negocio en una frase corta (máx 12 palabras), en español. '
      + 'Ej: "tienda de suplementos y artículos de gimnasio".',
    ),
});

// Asks the model for a short rich descriptor of the business. Returns null on
// any failure (no key / API error) so callers leave the previous context intact
// and retry next time. Never throws.
async function inferBusinessContext(params: {
  orgId: string;
  inferredBusinessType: string | null;
  topCategoryNames: string[];
  sampleProductNames: string[];
}): Promise<string | null> {
  const { orgId, inferredBusinessType, topCategoryNames, sampleProductNames }
    = params;

  const byokKey = await resolveOrgOpenAiKey(orgId);
  const apiKey = byokKey ?? Env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const cats = topCategoryNames.filter(Boolean).slice(0, 10).join(', ') || '—';
  const sample
    = sampleProductNames.filter(Boolean).slice(0, 40).join(', ') || '—';
  const coarse = inferredBusinessType ?? 'desconocido';

  try {
    const openai = createOpenAI({ apiKey });
    const { object } = await generateObject({
      model: openai(CONTEXT_MODEL),
      schema: contextSchema,
      prompt:
        `Eres un analista de retail. A partir de las señales de un negocio `
        + `colombiano, describe en una frase corta (máx 12 palabras, en español) `
        + `qué TIPO de negocio es, para guiar la categorización de su catálogo. `
        + `Clasificación gruesa: ${coarse}. `
        + `Categorías principales: ${cats}. `
        + `Muestra de productos: ${sample}. `
        + `Devuelve solo la descripción del tipo de negocio.`,
    });
    return object.context.trim() || null;
  } catch (err) {
    logger.error('ai_context_inference_failed', {
      organizationId: orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

type ContextShift = {
  shifted: boolean;
  context: string | null;
  previousContext: string | null;
};

// Refreshes the org's AI business context only when the deterministic signature
// has moved. Reads the latest deterministic snapshot (populated by
// recomputeBusinessProfile), so callers should run that first. Swallows its own
// errors — a failed inference must never break the Products page. Returns the
// shift so the caller can decide whether to trigger a Layer-3 re-categorization.
export async function recomputeAiContextIfShifted(
  orgId: string,
): Promise<ContextShift> {
  const noShift: ContextShift = {
    shifted: false,
    context: null,
    previousContext: null,
  };
  try {
    const [row] = await db
      .select({
        inferredBusinessType: businessProfileSchema.inferredBusinessType,
        productCount: businessProfileSchema.productCount,
        topCategories: businessProfileSchema.topCategories,
        aiBusinessContext: businessProfileSchema.aiBusinessContext,
        aiContextSignature: businessProfileSchema.aiContextSignature,
      })
      .from(businessProfileSchema)
      .where(eq(businessProfileSchema.organizationId, orgId))
      .limit(1);

    // No deterministic snapshot yet — recomputeBusinessProfile must run first.
    if (!row) {
      return noShift;
    }

    const topNames = (row.topCategories ?? []).map(c => c.name);
    const signature = buildContextSignature({
      inferredBusinessType: row.inferredBusinessType,
      productCount: row.productCount,
      topCategoryNames: topNames,
    });

    // Fresh: same signature and we already have a context string.
    if (signature === row.aiContextSignature && row.aiBusinessContext) {
      return {
        shifted: false,
        context: row.aiBusinessContext,
        previousContext: row.aiBusinessContext,
      };
    }

    const sampleRes = await db.execute(sql`
      SELECT name FROM products
      WHERE organization_id = ${orgId} AND deleted = false
      ORDER BY created_at DESC
      LIMIT 40
    `);
    const sampleProductNames = (sampleRes.rows ?? []).map(r =>
      String((r as Record<string, unknown>).name ?? ''),
    );

    const context = await inferBusinessContext({
      orgId,
      inferredBusinessType: row.inferredBusinessType,
      topCategoryNames: topNames,
      sampleProductNames,
    });

    // Inference failed — keep the previous context and DON'T poison the
    // signature, so the next load retries.
    if (!context) {
      return {
        shifted: false,
        context: row.aiBusinessContext,
        previousContext: row.aiBusinessContext,
      };
    }

    await db
      .update(businessProfileSchema)
      .set({
        aiBusinessContext: context,
        aiContextSignature: signature,
        aiContextComputedAt: new Date(),
      })
      .where(eq(businessProfileSchema.organizationId, orgId));

    const previousContext = row.aiBusinessContext;
    return {
      shifted: previousContext !== context,
      context,
      previousContext,
    };
  } catch (err) {
    logger.error('ai_context_refresh_failed', {
      organizationId: orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return noShift;
  }
}

// Read-only accessor for the stored context — used by the categorizer to bias
// its prompt without recomputing anything. Returns null when there's no context
// yet. Never throws.
export async function getBusinessContext(
  orgId: string,
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ aiBusinessContext: businessProfileSchema.aiBusinessContext })
      .from(businessProfileSchema)
      .where(eq(businessProfileSchema.organizationId, orgId))
      .limit(1);
    return row?.aiBusinessContext ?? null;
  } catch {
    return null;
  }
}
