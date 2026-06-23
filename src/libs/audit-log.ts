// Append-only audit trail. logAction() is invoked from every server action /
// API mutation that should leave a footprint (sales, returns, customer or
// product edits, cash open/close, employee invitations, plan changes, etc.).
//
// Failure to write an audit row must never roll back the mutation that
// produced it — we log to the runtime logger and swallow the error.

import type { PosAuthContext } from '@/libs/pos-auth';
import { clerkClient } from '@clerk/nextjs/server';
import { and, eq, inArray } from 'drizzle-orm';
import { headers } from 'next/headers';
import { db } from '@/libs/DB';
import { logger } from '@/libs/Logger';
import { auditLogsSchema, posUsersSchema } from '@/models/Schema';

export type AuditActorType = 'user' | 'cashier' | 'system' | 'api';

export type AuditActor = {
  type: AuditActorType;
  id: string;
};

// Either the pooled db or an open transaction handle. Callers that must write
// the audit row inside a locked transaction (e.g. the post-sale convergence
// sentinel) pass their tx so the write commits atomically with the effects it
// gates.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  // Optional executor. Defaults to the pooled db (back-compat with every
  // existing caller). Pass a tx to write inside an open transaction.
  executor?: Executor;
  // When true, a failed insert re-throws instead of being swallowed. Used by the
  // post-sale convergence sentinel: if the gating audit row can't be written, the
  // whole locked transaction MUST roll back so effects never commit ungated.
  throwOnError?: boolean;
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

export function resolvePosActor(ctx: PosAuthContext): AuditActor {
  return {
    type: 'cashier',
    id: ctx.cashierId ?? `device:${ctx.cashierName}`,
  };
}

const ACTOR_UUID_RE
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve audit actor ids to human-readable names. POS cashiers (UUID) come from
 * pos_users (org-scoped); panel admins (`user_*`) from Clerk (best-effort);
 * anything else stays as its raw id. Returns a Map keyed by actor id.
 */
export async function resolveActorNames(
  organizationId: string,
  actorIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = [...new Set(actorIds.filter(Boolean))];
  if (ids.length === 0) {
    return names;
  }

  const uuidIds = ids.filter(id => ACTOR_UUID_RE.test(id));
  const clerkIds = ids.filter(id => id.startsWith('user_'));

  if (uuidIds.length > 0) {
    const users = await db
      .select({ id: posUsersSchema.id, name: posUsersSchema.name })
      .from(posUsersSchema)
      .where(
        and(
          eq(posUsersSchema.organizationId, organizationId),
          inArray(posUsersSchema.id, uuidIds),
        ),
      );
    for (const u of users) {
      names.set(u.id, u.name);
    }
  }

  if (clerkIds.length > 0) {
    try {
      const client = await clerkClient();
      const { data } = await client.users.getUserList({
        userId: clerkIds,
        limit: clerkIds.length,
      });
      for (const u of data) {
        names.set(
          u.id,
          u.fullName
          || [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
          || u.primaryEmailAddress?.emailAddress
          || u.id,
        );
      }
    } catch {
      // Clerk unavailable → those actors fall back to their raw id.
    }
  }

  return names;
}

export async function logAction(input: LogActionInput): Promise<void> {
  try {
    const meta
      = input.ip !== undefined || input.userAgent !== undefined
        ? { ip: input.ip ?? null, userAgent: input.userAgent ?? null }
        : await readRequestMeta();

    const executor = input.executor ?? db;
    await executor.insert(auditLogsSchema).values({
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
    if (input.throwOnError) {
      throw err;
    }
  }
}
