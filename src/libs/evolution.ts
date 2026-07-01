// Evolution API v2 client for WhatsApp INSTANCE management (multi-tenant
// channels). This is distinct from libs/delivery-whatsapp.ts, which only SENDS
// text through a single fixed instance. Here each organization spins up its own
// instance, scans a QR, and routes inbound messages to n8n.
//
// Verified against the running instance: Evolution API 2.3.7. Auth is the
// `apikey` header; instance ops live under /instance/* and /webhook/*.

import { Env } from './Env';

// Events forwarded to n8n. Inbound messages only — n8n decides what to do with
// them ("los mensajes que el considere").
const WEBHOOK_EVENTS = ['MESSAGES_UPSERT'] as const;

type ConnectionState = 'open' | 'connecting' | 'close' | 'unknown';

export function config(): { base: string; key: string } | null {
  const base = Env.EVOLUTION_API_URL?.replace(/\/+$/, '');
  const key = Env.EVOLUTION_API_KEY;
  if (!base || !key) {
    return null;
  }
  return { base, key };
}

export function evolutionConfigured(): boolean {
  return config() !== null;
}

// Instance name encodes the orgId so n8n maps inbound -> org from the payload's
// `instance` field alone: `org_<clerkOrgId>__<short>`. Clerk org ids have no
// underscore after the `org_` prefix, so n8n can parse with /^(org_[^_]+)__/.
export function buildInstanceName(organizationId: string): string {
  const short = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `${organizationId}__${short}`;
}

async function evoFetch(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<unknown> {
  const cfg = config();
  if (!cfg) {
    throw new Error('evolution_not_configured');
  }
  const { json, ...rest } = init;
  const res = await fetch(`${cfg.base}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      'apikey': cfg.key,
      ...(rest.headers ?? {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`evolution_http_${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

function readQr(payload: unknown): string | null {
  const qr = (payload as { qrcode?: { base64?: string }; base64?: string }) ?? {};
  return qr.qrcode?.base64 ?? qr.base64 ?? null;
}

// Creates the instance with QR auth and, atomically, its webhook + events when
// a URL is given — so the instance is never live without inbound routing (key
// for high volume). Returns the QR data URL when Evolution includes it in the
// create response (it usually does with qrcode: true).
export async function createInstance(
  instanceName: string,
  webhookUrl?: string,
): Promise<{ qrBase64: string | null }> {
  const payload = await evoFetch('/instance/create', {
    method: 'POST',
    json: {
      instanceName,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      ...(webhookUrl
        ? {
            webhook: {
              url: webhookUrl,
              byEvents: false,
              base64: false,
              events: [...WEBHOOK_EVENTS],
            },
          }
        : {}),
    },
  });
  return { qrBase64: readQr(payload) };
}

// Points the instance at the shared n8n webhook. Evolution 2.2+ nests config
// under `webhook`. One URL for every instance; n8n discriminates by `instance`.
export async function setWebhook(instanceName: string, url: string): Promise<void> {
  await evoFetch(`/webhook/set/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    json: {
      webhook: {
        enabled: true,
        url,
        byEvents: false,
        base64: false,
        events: [...WEBHOOK_EVENTS],
      },
    },
  });
}

// Re-fetches a fresh QR (the QR rotates / expires while the modal is open).
export async function getQr(instanceName: string): Promise<{ qrBase64: string | null }> {
  const payload = await evoFetch(`/instance/connect/${encodeURIComponent(instanceName)}`);
  return { qrBase64: readQr(payload) };
}

function digitsFromJid(jid: unknown): string | null {
  if (typeof jid !== 'string') {
    return null;
  }
  const digits = jid.split('@')[0]?.replace(/\D/g, '') ?? '';
  return digits || null;
}

// Reads live connection state + the owner number. fetchInstances returns both;
// its shape shifted across 2.x patches, so we read defensively.
export async function fetchInstanceState(
  instanceName: string,
): Promise<{ state: ConnectionState; phoneNumber: string | null }> {
  const payload = await evoFetch(
    `/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`,
  );
  const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const raw = (list[0] ?? {}) as Record<string, unknown>;
  const inner = (raw.instance ?? raw) as Record<string, unknown>;

  const rawState = String(
    inner.connectionStatus ?? inner.state ?? inner.status ?? 'unknown',
  ).toLowerCase();
  const state: ConnectionState
    = rawState === 'open' || rawState === 'connected'
      ? 'open'
      : rawState === 'connecting'
        ? 'connecting'
        : rawState === 'close' || rawState === 'closed'
          ? 'close'
          : 'unknown';

  const phoneNumber
    = digitsFromJid(inner.ownerJid ?? inner.owner ?? raw.ownerJid ?? raw.owner);

  return { state, phoneNumber };
}

// Logs out (frees the WhatsApp session) then deletes the instance. Both are
// best-effort: a stale instance must not block removing the channel row.
export async function deleteInstance(instanceName: string): Promise<void> {
  const name = encodeURIComponent(instanceName);
  await evoFetch(`/instance/logout/${name}`, { method: 'DELETE' }).catch(() => {});
  await evoFetch(`/instance/delete/${name}`, { method: 'DELETE' }).catch(() => {});
}
