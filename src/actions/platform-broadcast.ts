'use server';

import type { ActionResult } from '@/libs/action-result';
import { desc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { listPlatformOrgs } from '@/actions/platform-orgs';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { requirePlatformOperator } from '@/libs/platform/operator';
import { notificationsSchema } from '@/models/Schema';

/**
 * Operator broadcast: pushes a `platform_announcement` notification into each
 * targeted business's bell. Targets resolve against the live directory, so
 * segments stay consistent with what the operator sees in /platform/businesses.
 */

export type BroadcastSeverity = 'low' | 'mid' | 'high';

export type BroadcastTarget
  = | { kind: 'all' }
    | { kind: 'status'; status: string }
    | { kind: 'tag'; tag: string };

export type BroadcastInput = {
  title: string;
  message: string;
  severity: BroadcastSeverity;
  target: BroadcastTarget;
};

export type SentBroadcast = {
  id: string;
  organizationId: string;
  title: string;
  message: string;
  severity: string;
  createdAt: string;
};

const SEVERITIES: BroadcastSeverity[] = ['low', 'mid', 'high'];

export async function sendBroadcast(
  input: BroadcastInput,
): Promise<ActionResult<{ delivered: number }>> {
  const operator = await requirePlatformOperator();

  const title = input.title.trim();
  const message = input.message.trim();
  if (!title) {
    return { ok: false, error: 'El título es obligatorio' };
  }
  if (!message) {
    return { ok: false, error: 'El mensaje es obligatorio' };
  }
  if (!SEVERITIES.includes(input.severity)) {
    return { ok: false, error: 'Severidad inválida' };
  }

  const orgs = await listPlatformOrgs();
  let targets = orgs;
  if (input.target.kind === 'status') {
    const status = input.target.status;
    targets = orgs.filter(o => o.status === status);
  } else if (input.target.kind === 'tag') {
    const tag = input.target.tag.trim().toLowerCase();
    targets = orgs.filter(o => o.tags.some(t => t.toLowerCase() === tag));
  }

  if (targets.length === 0) {
    return { ok: false, error: 'Ningún negocio coincide con el destino' };
  }

  await db.insert(notificationsSchema).values(
    targets.map(org => ({
      organizationId: org.organizationId,
      kind: 'platform_announcement' as const,
      severity: input.severity,
      title,
      message,
      payload: { sentBy: operator.userId },
    })),
  );

  await logAction({
    organizationId: 'platform',
    actor: { type: 'user', id: operator.userId },
    action: 'platform.broadcast.sent',
    entityType: 'notification',
    entityId: title,
    after: {
      target: input.target,
      severity: input.severity,
      delivered: targets.length,
    },
  });

  revalidatePath('/platform/alerts');
  return { ok: true, data: { delivered: targets.length } };
}

export async function listRecentBroadcasts(): Promise<SentBroadcast[]> {
  await requirePlatformOperator();

  const rows = await db
    .select({
      id: notificationsSchema.id,
      organizationId: notificationsSchema.organizationId,
      title: notificationsSchema.title,
      message: notificationsSchema.message,
      severity: notificationsSchema.severity,
      createdAt: notificationsSchema.createdAt,
    })
    .from(notificationsSchema)
    .where(eq(notificationsSchema.kind, 'platform_announcement'))
    .orderBy(desc(notificationsSchema.createdAt))
    .limit(40);

  return rows.map(r => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
  }));
}
