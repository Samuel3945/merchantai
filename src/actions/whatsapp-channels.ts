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
import {
  agentTokensSchema,
  conversationsSchema,
  whatsappChannelsSchema,
} from '@/models/Schema';

export type WhatsAppChannelStatus = 'connecting' | 'connected' | 'disconnected';

export type WhatsAppChannelInput = {
  label?: string;
  purpose?: string;
  capabilities?: Record<string, boolean>;
};

export type WhatsAppChannelRow = {
  id: string;
  label: string | null;
  purpose: string | null;
  capabilities: Record<string, boolean>;
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
  if (orgRole !== 'org:admin') {
    throw new Error('Only organization admins can manage WhatsApp channels');
  }
  return { userId, orgId };
}

function toRow(r: typeof whatsappChannelsSchema.$inferSelect): WhatsAppChannelRow {
  return {
    id: r.id,
    label: r.label,
    purpose: r.purpose,
    capabilities: r.capabilities ?? {},
    status: r.status,
    phoneNumber: r.phoneNumber,
    createdAt: r.createdAt.toISOString(),
  };
}

// Keeps only the boolean capability flags that are `true`, so the stored object
// stays small and explicit.
function cleanCapabilities(
  capabilities: Record<string, boolean> | undefined,
): Record<string, boolean> {
  if (!capabilities) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(capabilities).filter(([, v]) => v === true),
  );
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
  input: WhatsAppChannelInput = {},
): Promise<{ channel: WhatsAppChannelRow; qrBase64: string | null }> {
  const { userId, orgId } = await requireAdminOrg();

  if (!evolutionConfigured()) {
    throw new Error(
      'WhatsApp no está configurado: faltan EVOLUTION_API_URL y EVOLUTION_API_KEY en el entorno.',
    );
  }

  const instanceName = buildInstanceName(orgId);
  const webhookUrl = Env.WHATSAPP_N8N_WEBHOOK_URL;

  // Create the Evolution instance first so we never persist an orphan row. The
  // webhook + events are set atomically in the create call when a URL exists.
  const { qrBase64: createdQr } = await createInstance(instanceName, webhookUrl);

  // Belt-and-suspenders: re-assert the webhook (idempotent) in case a given
  // Evolution build ignores webhook-in-create. Best-effort — must not block the
  // QR the admin is waiting on.
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
    // Both inserts run in a single atomic transaction: channel + agent token.
    // A failure in either insert rolls back the other.
    row = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(whatsappChannelsSchema)
        .values({
          organizationId: orgId,
          instanceName,
          label: input.label?.trim() || null,
          purpose: input.purpose?.trim() || null,
          capabilities: cleanCapabilities(input.capabilities),
          status: 'connecting',
          createdBy: userId,
        })
        .returning();
      if (!inserted[0]) {
        throw new Error('whatsapp_channel_insert_failed');
      }
      const channelRow = inserted[0];

      // Auto-create the agent API token that n8n uses to authenticate against the
      // agent endpoints on this channel.
      await tx
        .insert(agentTokensSchema)
        .values({
          organizationId: orgId,
          channelId: channelRow.id,
          description: 'auto',
          active: true,
          createdBy: userId,
        });

      // The agent intentionally does NOT get its own POS device/caja. It must
      // operate against whatever cash session is already open — a paired
      // 'ai_agent' pos_token here surfaced phantom "cajas" in the cash panel that
      // never open a shift, and nothing ever consumed that token.

      return channelRow;
    });
  } catch (err) {
    // Roll the Evolution instance back so a failed DB transaction leaves nothing behind.
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

export async function updateWhatsAppChannel(
  id: string,
  input: WhatsAppChannelInput,
): Promise<WhatsAppChannelRow> {
  const { orgId } = await requireAdminOrg();

  const [updated] = await db
    .update(whatsappChannelsSchema)
    .set({
      label: input.label?.trim() || null,
      purpose: input.purpose?.trim() || null,
      capabilities: cleanCapabilities(input.capabilities),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(whatsappChannelsSchema.id, id),
        eq(whatsappChannelsSchema.organizationId, orgId),
      ),
    )
    .returning();
  if (!updated) {
    throw new Error('Channel not found');
  }
  return toRow(updated);
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

  // Delete child rows + channel atomically. If the DB transaction fails the
  // Evolution instance stays intact (no data torn between systems).
  // Delete child conversations before the channel row so the
  // conversations.channelId RESTRICT FK does not block the delete.
  // Messages cascade automatically via conversations.id ON DELETE CASCADE.
  await db.transaction(async (tx) => {
    await tx.delete(conversationsSchema).where(eq(conversationsSchema.channelId, id));
    await tx.delete(whatsappChannelsSchema).where(eq(whatsappChannelsSchema.id, id));
  });

  // Best-effort Evolution teardown — runs AFTER the DB transaction commits so a
  // failure here never leaves DB rows orphaned with a missing Evolution instance.
  await deleteInstance(row.instanceName).catch(() => {});
}

/**
 * Rotate the agent API token for a channel.
 * Deactivates the current active token and creates a replacement so in-flight
 * n8n flows see a 401 and must be reconfigured with the new bearer.
 */
export async function regenerateAgentToken(channelId: string): Promise<void> {
  const { userId, orgId } = await requireAdminOrg();

  await db
    .update(agentTokensSchema)
    .set({ active: false })
    .where(
      and(
        eq(agentTokensSchema.channelId, channelId),
        eq(agentTokensSchema.organizationId, orgId),
        eq(agentTokensSchema.active, true),
      ),
    );

  await db
    .insert(agentTokensSchema)
    .values({
      organizationId: orgId,
      channelId,
      description: 'regenerated',
      active: true,
      createdBy: userId,
    });
}

/**
 * Permanently revoke a specific agent token by id.
 * The n8n flow using this token will receive 401 on its next request.
 */
export async function revokeAgentToken(tokenId: string): Promise<void> {
  const { orgId } = await requireAdminOrg();

  await db
    .update(agentTokensSchema)
    .set({ active: false })
    .where(
      and(
        eq(agentTokensSchema.id, tokenId),
        eq(agentTokensSchema.organizationId, orgId),
      ),
    );
}
