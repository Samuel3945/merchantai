'use server';

import { auth } from '@clerk/nextjs/server';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { Env } from '@/libs/Env';
import {
  buildInstanceName,
  createInstance,
  deleteInstance,
  evolutionConfigured,
  fetchInstanceState,
  getQr,
  setWebhook,
} from '@/libs/evolution';
import { logger } from '@/libs/Logger';
import { whatsappChannelsSchema } from '@/models/Schema';

export type WhatsAppChannelStatus = 'connecting' | 'connected' | 'disconnected';

export type WhatsAppChannelRow = {
  id: string;
  label: string | null;
  status: WhatsAppChannelStatus;
  phoneNumber: string | null;
  createdAt: string;
};

async function requireAdminOrg() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole && orgRole !== 'org:admin') {
    throw new Error('Only organization admins can manage WhatsApp channels');
  }
  return { userId, orgId };
}

function toRow(r: typeof whatsappChannelsSchema.$inferSelect): WhatsAppChannelRow {
  return {
    id: r.id,
    label: r.label,
    status: r.status,
    phoneNumber: r.phoneNumber,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listWhatsAppChannels(): Promise<WhatsAppChannelRow[]> {
  const { orgId } = await requireAdminOrg();
  const rows = await db
    .select()
    .from(whatsappChannelsSchema)
    .where(eq(whatsappChannelsSchema.organizationId, orgId))
    .orderBy(desc(whatsappChannelsSchema.createdAt));
  return rows.map(toRow);
}

export async function createWhatsAppChannel(
  label?: string,
): Promise<{ channel: WhatsAppChannelRow; qrBase64: string | null }> {
  const { userId, orgId } = await requireAdminOrg();

  if (!evolutionConfigured()) {
    throw new Error(
      'WhatsApp no está configurado: faltan EVOLUTION_API_URL y EVOLUTION_API_KEY en el entorno.',
    );
  }

  const instanceName = buildInstanceName(orgId);

  // Create the Evolution instance first so we never persist an orphan row.
  const { qrBase64: createdQr } = await createInstance(instanceName);

  // Route inbound messages to n8n. Best-effort: a webhook hiccup must not block
  // the QR/connection the admin is waiting on — they can reconnect later.
  const webhookUrl = Env.WHATSAPP_N8N_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await setWebhook(instanceName, webhookUrl);
    } catch (err) {
      logger.error('whatsapp_set_webhook_failed', {
        organizationId: orgId,
        instanceName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    logger.warn('whatsapp_webhook_url_missing', { organizationId: orgId });
  }

  let row: typeof whatsappChannelsSchema.$inferSelect;
  try {
    const inserted = await db
      .insert(whatsappChannelsSchema)
      .values({
        organizationId: orgId,
        instanceName,
        label: label?.trim() || null,
        status: 'connecting',
        createdBy: userId,
      })
      .returning();
    if (!inserted[0]) {
      throw new Error('whatsapp_channel_insert_failed');
    }
    row = inserted[0];
  } catch (err) {
    // Roll the Evolution instance back so a failed insert leaves nothing behind.
    await deleteInstance(instanceName).catch(() => {});
    throw err;
  }

  // Evolution usually returns the QR on create; if not, pull a fresh one.
  let qrBase64 = createdQr;
  if (!qrBase64) {
    qrBase64 = (await getQr(instanceName).catch(() => ({ qrBase64: null }))).qrBase64;
  }

  return { channel: toRow(row), qrBase64 };
}

export async function getWhatsAppChannelStatus(
  id: string,
): Promise<{ status: WhatsAppChannelStatus; phoneNumber: string | null }> {
  const { orgId } = await requireAdminOrg();

  const [row] = await db
    .select()
    .from(whatsappChannelsSchema)
    .where(
      and(
        eq(whatsappChannelsSchema.id, id),
        eq(whatsappChannelsSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error('Channel not found');
  }

  const { state, phoneNumber } = await fetchInstanceState(row.instanceName);
  const next: WhatsAppChannelStatus
    = state === 'open'
      ? 'connected'
      : state === 'close'
        ? 'disconnected'
        : state === 'connecting'
          ? 'connecting'
          : row.status;

  if (next !== row.status || (phoneNumber && phoneNumber !== row.phoneNumber)) {
    await db
      .update(whatsappChannelsSchema)
      .set({
        status: next,
        phoneNumber: phoneNumber ?? row.phoneNumber,
        updatedAt: new Date(),
      })
      .where(eq(whatsappChannelsSchema.id, id));
  }

  return { status: next, phoneNumber: phoneNumber ?? row.phoneNumber };
}

export async function refreshWhatsAppChannelQr(
  id: string,
): Promise<{ qrBase64: string | null }> {
  const { orgId } = await requireAdminOrg();

  const [row] = await db
    .select()
    .from(whatsappChannelsSchema)
    .where(
      and(
        eq(whatsappChannelsSchema.id, id),
        eq(whatsappChannelsSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error('Channel not found');
  }

  return getQr(row.instanceName);
}

export async function deleteWhatsAppChannel(id: string): Promise<void> {
  const { orgId } = await requireAdminOrg();

  const [row] = await db
    .select()
    .from(whatsappChannelsSchema)
    .where(
      and(
        eq(whatsappChannelsSchema.id, id),
        eq(whatsappChannelsSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) {
    return;
  }

  await deleteInstance(row.instanceName);
  await db.delete(whatsappChannelsSchema).where(eq(whatsappChannelsSchema.id, id));
}
