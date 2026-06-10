import { Env } from './Env';

export type WhatsAppSendResult
  = | { sent: true }
    | { sent: false; skipped: true; reason: string }
    | { sent: false; skipped: false; error: string };

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * Sends a plain-text WhatsApp message through Evolution API.
 *
 * When the integration env is not configured this is a deliberate no-op
 * (`skipped`) so the rest of the app works without WhatsApp wired. It NEVER
 * throws: messaging is best-effort and must not break a delivery status change
 * the courier already performed.
 */
export async function sendWhatsAppText(
  to: string | null | undefined,
  text: string,
): Promise<WhatsAppSendResult> {
  const base = Env.EVOLUTION_API_URL;
  const key = Env.EVOLUTION_API_KEY;
  const instance = Env.EVOLUTION_INSTANCE;
  const number = to ? normalizePhone(to) : '';

  if (!base || !key || !instance) {
    return { sent: false, skipped: true, reason: 'evolution_not_configured' };
  }
  if (!number) {
    return { sent: false, skipped: true, reason: 'missing_recipient' };
  }

  try {
    const res = await fetch(
      `${base.replace(/\/$/, '')}/message/sendText/${encodeURIComponent(instance)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': key },
        body: JSON.stringify({ number, text }),
      },
    );
    if (!res.ok) {
      return { sent: false, skipped: false, error: `evolution_http_${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    return {
      sent: false,
      skipped: false,
      error: e instanceof Error ? e.message : 'send_failed',
    };
  }
}
