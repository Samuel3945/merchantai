'use server';

import type { AuditActorType } from '@/libs/audit-log';
import { auth } from '@clerk/nextjs/server';
import { and, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { auditLogsSchema } from '@/models/Schema';

export type AuditLogRow = {
  id: string;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
};

export type ListAuditLogsParams = {
  start?: string | null;
  end?: string | null;
  action?: string | null;
  actorId?: string | null;
  entityType?: string | null;
  page?: number;
  pageSize?: number;
};

export type ListAuditLogsResult = {
  items: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
};

const MAX_PAGE_SIZE = 200;

async function requireAdminOrg() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole && orgRole !== 'org:admin') {
    throw new Error('Only organization admins can view the audit log');
  }
  return { userId, orgId };
}

function buildFilters(orgId: string, params: ListAuditLogsParams) {
  const conds = [eq(auditLogsSchema.organizationId, orgId)];

  if (params.start) {
    conds.push(gte(auditLogsSchema.createdAt, new Date(params.start)));
  }
  if (params.end) {
    // Inclusive end-of-day: callers pass a YYYY-MM-DD; we treat it as
    // <= end + 1 day so a same-day range matches.
    const end = new Date(params.end);
    end.setHours(23, 59, 59, 999);
    conds.push(lte(auditLogsSchema.createdAt, end));
  }
  if (params.action) {
    conds.push(eq(auditLogsSchema.action, params.action));
  }
  if (params.actorId) {
    conds.push(ilike(auditLogsSchema.actorId, `%${params.actorId.trim()}%`));
  }
  if (params.entityType) {
    conds.push(eq(auditLogsSchema.entityType, params.entityType));
  }

  return and(...conds);
}

export async function listAuditLogs(
  params: ListAuditLogsParams = {},
): Promise<ListAuditLogsResult> {
  const { orgId } = await requireAdminOrg();

  const page = Math.max(params.page ?? 1, 1);
  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), MAX_PAGE_SIZE);
  const where = buildFilters(orgId, params);

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(auditLogsSchema)
      .where(where)
      .orderBy(desc(auditLogsSchema.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogsSchema)
      .where(where),
  ]);

  return {
    items: rows.map(r => ({
      id: r.id,
      actorType: r.actorType,
      actorId: r.actorId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      before: r.before,
      after: r.after,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      ip: r.ip,
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
    })),
    total: totalRow[0]?.count ?? 0,
    page,
    pageSize,
  };
}

export type AuditFacets = {
  actions: string[];
  entityTypes: string[];
};

// Distinct action/entityType lists, scoped to the org, so the filter dropdowns
// stay accurate as new event kinds get instrumented.
export async function getAuditFacets(): Promise<AuditFacets> {
  const { orgId } = await requireAdminOrg();

  const [actions, entityTypes] = await Promise.all([
    db
      .selectDistinct({ value: auditLogsSchema.action })
      .from(auditLogsSchema)
      .where(eq(auditLogsSchema.organizationId, orgId))
      .orderBy(auditLogsSchema.action),
    db
      .selectDistinct({ value: auditLogsSchema.entityType })
      .from(auditLogsSchema)
      .where(eq(auditLogsSchema.organizationId, orgId))
      .orderBy(auditLogsSchema.entityType),
  ]);

  return {
    actions: actions.map(a => a.value),
    entityTypes: entityTypes.map(e => e.value),
  };
}
