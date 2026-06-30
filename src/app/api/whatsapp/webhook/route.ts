import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs } from 'ai';
import { createDeliveryOrderTool } from '@/features/delivery/agent-tools';
import { sendWhatsAppText } from '@/libs/delivery-whatsapp';
import { Env } from '@/libs/Env';

export const dynamic = 'force-dynamic';

// Minimal shape of the Evolution API "messages.upsert" webhook payload. Defined
// loosely on purpose — we only read what intake needs and ignore the rest.
type EvolutionPayload = {
  instance?: string;
  data?: {
    instance?: string;
    key?: { remoteJid?: string; fromMe?: boolean };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
    };
  };
};

type Inbound = {
  from: string | null;
  text: string | null;
  instance: string | null;
};

function extractInbound(payload: EvolutionPayload): Inbound {
  const data = payload.data ?? {};
  const instance = payload.instance ?? data.instance ?? null;
  const key = data.key ?? {};
  // Ignore our own outbound echoes.
  if (key.fromMe) {
    return { from: null, text: null, instance };
  }
  const from = key.remoteJid ? key.remoteJid.replace(/@.*/, '') : null;
  const msg = data.message ?? {};
  const text = msg.conversation ?? msg.extendedTextMessage?.text ?? null;
  return { from, text, instance };
}

// Resolves which org a WhatsApp instance belongs to. Until a per-instance
// channel mapping is persisted, falls back to WHATSAPP_DEFAULT_ORG_ID
// (single-tenant). This is the seam to extend for multi-tenant routing.
function resolveOrgId(_instance: string | null): string | null {
  return Env.WHATSAPP_DEFAULT_ORG_ID ?? null;
}

export async function POST(req: Request) {
  // Authenticate the webhook with a shared token (header or ?token=).
  const url = new URL(req.url);
  const token
    = req.headers.get('x-webhook-token') ?? url.searchParams.get('token');
  if (!Env.WHATSAPP_WEBHOOK_TOKEN || token !== Env.WHATSAPP_WEBHOOK_TOKEN) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // When n8n is the active processor, return a 200 no-op immediately.
  // This prevents double-processing: n8n drives the LLM conversation and
  // creates deliveries through its own webhook; the in-app agent must be silent.
  if (Env.WHATSAPP_N8N_WEBHOOK_URL) {
    return Response.json({ ok: true, neutralized: true });
  }

  let payload: EvolutionPayload;
  try {
    payload = (await req.json()) as EvolutionPayload;
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  const { from, text, instance } = extractInbound(payload);
  // Only inbound text messages drive intake; ack everything else.
  if (!from || !text) {
    return Response.json({ ok: true, ignored: true });
  }

  const orgId = resolveOrgId(instance);
  if (!orgId) {
    return Response.json({ ok: true, ignored: 'no_org' });
  }
  if (!Env.OPENAI_API_KEY) {
    return Response.json({ ok: true, ignored: 'no_model' });
  }

  try {
    // NOTE: single-turn intake (no per-sender conversation memory yet). Good
    // enough to parse a complete order in one message; multi-turn threading is
    // the next refinement.
    const openai = createOpenAI({ apiKey: Env.OPENAI_API_KEY });
    const result = await generateText({
      model: openai('gpt-4o-mini'),
      system: `Eres el asistente de pedidos a domicilio de un negocio colombiano que atiende por WhatsApp.
Tu trabajo: conversar con el cliente, tomar su pedido y, cuando tengas la dirección de entrega, crear el pedido con la herramienta create_delivery_order.
Reglas:
- No inventes precios ni productos. Si no los conoces, pídelos al cliente.
- Crea el pedido SOLO cuando tengas la dirección de entrega.
- El número del cliente es ${from}; pásalo como customerPhone.
- Responde breve y cordial, en español.`,
      prompt: text,
      tools: { create_delivery_order: createDeliveryOrderTool(orgId) },
      stopWhen: stepCountIs(4),
    });

    if (result.text) {
      await sendWhatsAppText(from, result.text);
    }
    return Response.json({ ok: true });
  } catch (e) {
    // Ack with 200 so Evolution doesn't hammer retries on a transient model error.
    return Response.json({
      ok: false,
      error: e instanceof Error ? e.message : 'agent_failed',
    });
  }
}
