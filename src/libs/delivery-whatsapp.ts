import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { whatsappChannelsSchema } from '@/models/Schema';
import { Env } from './Env';
import { config as evolutionConfig } from './evolution';

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

/**
 * Multi-tenant variant of {@link sendWhatsAppText}: sends through the ORG's own
 * connected WhatsApp channel instead of the single fixed `EVOLUTION_INSTANCE`.
 *
 * Resolves the most recently updated `connected` channel for the org and POSTs
 * to its Evolution instance, reusing evolution.ts's `config()` for the base URL
 * and apikey. Same never-throw, discriminated-union contract as
 * {@link sendWhatsAppText}: it no-ops (`skipped`, reason `no_connected_channel`)
 * when the org has no connected channel, and never breaks a status change the
 * courier already performed.
 */
export async function sendWhatsAppTextForOrg(
  orgId: string,
  to: string | null | undefined,
  text: string,
): Promise<WhatsAppSendResult> {
  const cfg = evolutionConfig();
  const number = to ? normalizePhone(to) : '';

  if (!cfg) {
    return { sent: false, skipped: true, reason: 'evolution_not_configured' };
  }
  if (!number) {
    return { sent: false, skipped: true, reason: 'missing_recipient' };
  }

  const [channel] = await db
    .select({ instanceName: whatsappChannelsSchema.instanceName })
    .from(whatsappChannelsSchema)
    .where(
      and(
        eq(whatsappChannelsSchema.organizationId, orgId),
        eq(whatsappChannelsSchema.status, 'connected'),
      ),
    )
    .orderBy(desc(whatsappChannelsSchema.updatedAt))
    .limit(1);

  if (!channel) {
    return { sent: false, skipped: true, reason: 'no_connected_channel' };
  }

  try {
    const res = await fetch(
      `${cfg.base}/message/sendText/${encodeURIComponent(channel.instanceName)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': cfg.key },
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
