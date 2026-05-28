// Append-only audit trail. logAction() is invoked from every server action /
// API mutation that should leave a footprint (sales, returns, customer or
// product edits, cash open/close, employee invitations, plan changes, etc.).
//
// Failure to write an audit row must never roll back the mutation that
// produced it — we log to the runtime logger and swallow the error.

import type { PosAuthContext } from '@/libs/pos-auth';
import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { db } from '@/libs/DB';
import { logger } from '@/libs/Logger';
import { auditLogsSchema } from '@/models/Schema';

export type AuditActorType = 'user' | 'cashier' | 'system' | 'api';

export type AuditActor = {
  type: AuditActorType;
  id: string;
};

export type LogActionInput = {
  organizationId: string;
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
};

// `next/headers` is only callable inside a request scope (server actions,
// route handlers, RSC). Outside of that — e.g. cron jobs — it throws, so we
// catch and return nulls.
async function readRequestMeta(): Promise<{
  ip: string | null;
  userAgent: string | null;
}> {
  try {
    const h = await headers();
    const forwarded = h.get('x-forwarded-for');
    const ip
      = forwarded?.split(',')[0]?.trim()
        || h.get('x-real-ip')
        || h.get('cf-connecting-ip')
        || null;
    return { ip, userAgent: h.get('user-agent') };
  } catch {
    return { ip: null, userAgent: null };
  }
}

// Resolve the current Clerk-authenticated actor inside a dashboard server
// action. Returns null when there is no Clerk session — the caller is then
// responsible for using a system / api / cashier actor instead.
export async function resolveClerkActor(): Promise<AuditActor | null> {
  try {
    const { userId } = await auth();
    if (!userId) {
      return null;
    }
    return { type: 'user', id: userId };
  } catch {
    return null;
  }
}

export function resolvePosActor(ctx: PosAuthContext): AuditActor {
  return {
    type: 'cashier',
    id: ctx.cashierId ?? `device:${ctx.cashierName}`,
  };
}

export function systemActor(name: string): AuditActor {
  return { type: 'system', id: name };
}

export function apiActor(source: string): AuditActor {
  return { type: 'api', id: source };
}

export async function logAction(input: LogActionInput): Promise<void> {
  try {
    const meta
      = input.ip !== undefined || input.userAgent !== undefined
        ? { ip: input.ip ?? null, userAgent: input.userAgent ?? null }
        : await readRequestMeta();

    await db.insert(auditLogsSchema).values({
      organizationId: input.organizationId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: (input.before ?? null) as unknown,
      after: (input.after ?? null) as unknown,
      metadata: (input.metadata ?? {}) as Record<string, unknown>,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  } catch (err) {
    logger.error('audit_log_write_failed', {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      organizationId: input.organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
