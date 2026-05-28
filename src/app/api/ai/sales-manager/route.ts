import type { UIMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { auth } from '@clerk/nextjs/server';
import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import { z } from 'zod';
import { consumeCredit } from '@/actions/plans';
import { runReadOnlyQuery, TABLE_CATALOG } from '@/libs/ai-catalog';

export async function POST(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const credit = await consumeCredit('sales_manager');
  if (!credit.success) {
    return Response.json(
      { error: 'no_credits', remaining: 0 },
      { status: 402 },
    );
  }

  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: anthropic('claude-haiku-4-5-20251001'),
    system: `Eres el Sales Manager AI de un negocio colombiano. Respondes preguntas sobre ventas, productos, clientes e inventario.

Tu trabajo:
1. Interpretar la pregunta del usuario en lenguaje natural.
2. Generar y ejecutar una consulta SQL read-only usando la herramienta run_sql.
3. Analizar los resultados y responder en español con datos concretos.
4. Si los datos se prestan para visualización, incluye un bloque JSON para graficar.

${TABLE_CATALOG}

Cuando los datos se prestan para un gráfico (tendencias, rankings, comparaciones), incluye al final de tu respuesta un bloque:
\`\`\`chart
{ "type": "bar"|"line", "xKey": "column_name", "yKey": "column_name", "data": [...rows...] }
\`\`\`

Responde siempre en español. Sé conciso y directo.`,
    messages: convertToModelMessages(messages),
    tools: {
      run_sql: {
        description: 'Execute a read-only SQL query on the business database. Always include :org_id as the organization_id filter.',
        inputSchema: z.object({
          query: z.string().describe('SQL SELECT query with :org_id placeholder'),
        }),
        execute: async ({ query }: { query: string }) => {
          try {
            const rows = await runReadOnlyQuery(orgId, query);
            return { success: true, rows, rowCount: rows.length };
          } catch (e) {
            return { success: false, error: e instanceof Error ? e.message : 'Query failed' };
          }
        },
      },
    },
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse({
    headers: { 'X-Credits-Remaining': String(credit.remaining) },
  });
}
