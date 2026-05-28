import type { UIMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { auth } from '@clerk/nextjs/server';
import { convertToModelMessages, streamText } from 'ai';
import { and, eq } from 'drizzle-orm';
import { consumeCredit } from '@/actions/plans';
import { db } from '@/libs/DB';
import { appSettingsSchema, productsSchema } from '@/models/Schema';

async function loadBusinessContext(orgId: string) {
  const keys = [
    'business_name',
    'business_phone',
    'business_address',
    'business_type',
    'business_currency',
    'business_timezone',
  ];

  const settings = await db
    .select({ key: appSettingsSchema.key, value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(eq(appSettingsSchema.organizationId, orgId));

  const map = Object.fromEntries(settings.map(s => [s.key, s.value]));
  const businessInfo = keys
    .filter(k => map[k])
    .map(k => `${k.replace('business_', '')}: ${map[k]}`)
    .join('\n');

  const products = await db
    .select({
      name: productsSchema.name,
      price: productsSchema.price,
      category: productsSchema.category,
      stock: productsSchema.stock,
    })
    .from(productsSchema)
    .where(
      and(
        eq(productsSchema.organizationId, orgId),
        eq(productsSchema.status, 'published'),
        eq(productsSchema.deleted, false),
      ),
    )
    .limit(80);

  const catalog = products
    .map(p => `- ${p.name} | $${p.price} | ${p.category ?? 'Sin categoría'} | Stock: ${p.stock}`)
    .join('\n');

  return { businessInfo, catalog };
}

export async function POST(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const credit = await consumeCredit('customer_service');
  if (!credit.success) {
    return Response.json(
      { error: 'no_credits', remaining: 0 },
      { status: 402 },
    );
  }

  const { messages }: { messages: UIMessage[] } = await req.json();
  const { businessInfo, catalog } = await loadBusinessContext(orgId);

  const result = streamText({
    model: anthropic('claude-haiku-4-5-20251001'),
    system: `Eres el asistente de atención al cliente de un negocio. Respondes preguntas de los clientes sobre productos, precios, disponibilidad, horarios y ofertas.

Información del negocio:
${businessInfo || 'No configurada aún.'}

Catálogo de productos disponibles:
${catalog || 'No hay productos publicados.'}

Reglas:
- Responde siempre en español, de forma amable y concisa.
- Si no tienes la información, dilo honestamente y sugiere contactar al negocio.
- No inventes precios ni disponibilidad. Solo usa los datos del catálogo.
- Si preguntan por un producto que no está en el catálogo, indica que no está disponible o que deben consultar directamente.
- Sé cordial y profesional.`,
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    headers: { 'X-Credits-Remaining': String(credit.remaining) },
  });
}
