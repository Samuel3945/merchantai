'use server';

import type { CashMovement, CashMovementType, CashSession } from '@/libs/cash-helpers';
import { auth, currentUser } from '@clerk/nextjs/server';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import {
  computeExpectedAmount,
  EXPENSE_MOVEMENT_TYPES,
  findOpenSession,
  INCOME_MOVEMENT_TYPES,
  toMoney,
} from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { cashMovementsSchema, cashSessionsSchema } from '@/models/Schema';
import { notifyCashDifference } from './notifications';

async function requireOrg() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return { userId, orgId };
}

async function getActorName(fallback: string): Promise<string> {
  try {
    const user = await currentUser();
    const candidate
      = user?.fullName
        || [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()
        || user?.username
        || user?.primaryEmailAddress?.emailAddress;
    return candidate && candidate.length > 0 ? candidate : fallback;
  } catch {
    return fallback;
  }
}

export async function openCashSession(
  openingAmount: number | string,
  notes?: string | null,
): Promise<CashSession> {
  const { userId, orgId } = await requireOrg();
  const actor = await getActorName(userId);

  const opening = toMoney(openingAmount ?? 0);
  if (Number.parseFloat(opening) < 0) {
    throw new Error('Opening amount must be >= 0');
  }

  const session = await db.transaction(async (tx) => {
    const existing = await findOpenSession(tx, orgId);
    if (existing) {
      throw new Error('Ya hay una caja abierta en esta organización');
    }

    const [created] = await tx
      .insert(cashSessionsSchema)
      .values({
        organizationId: orgId,
        openingAmount: opening,
        openedBy: actor,
        status: 'open',
        notes: notes ?? null,
      })
      .returning();

    if (!created) {
      throw new Error('Failed to open cash session');
    }
    return created;
  });

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'cash.opened',
    entityType: 'cash_session',
    entityId: session.id,
    after: {
      id: session.id,
      openingAmount: session.openingAmount,
      openedBy: session.openedBy,
      notes: session.notes,
    },
  });

  revalidatePath('/dashboard/cash');
  return session;
}

export async function closeCashSession(
  countedAmount: number | string,
  notes?: string | null,
): Promise<CashSession> {
  const { userId, orgId } = await requireOrg();
  const actor = await getActorName(userId);

  const counted = toMoney(countedAmount);

  const session = await db.transaction(async (tx) => {
    const open = await findOpenSession(tx, orgId);
    if (!open) {
      throw new Error('No hay caja abierta para cerrar');
    }

    const expected = await computeExpectedAmount(tx, open);
    const difference = Number.parseFloat(
      (Number.parseFloat(counted) - expected).toFixed(2),
    );

    const mergedNotes = notes
      ? open.notes
        ? `${open.notes}; cierre: ${notes}`
        : `cierre: ${notes}`
      : open.notes;

    const [closed] = await tx
      .update(cashSessionsSchema)
      .set({
        status: 'closed',
        closedAt: new Date(),
        closedBy: actor,
        countedAmount: counted,
        expectedAmount: toMoney(expected),
        difference: toMoney(difference),
        notes: mergedNotes,
      })
      .where(eq(cashSessionsSchema.id, open.id))
      .returning();

    if (!closed) {
      throw new Error('Failed to close cash session');
    }
    return closed;
  });

  try {
    await notifyCashDifference({
      organizationId: orgId,
      sessionId: session.id,
      difference: Number.parseFloat(session.difference ?? '0') || 0,
    });
  } catch {
    // Notification failure must not roll back the close.
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'cash.closed',
    entityType: 'cash_session',
    entityId: session.id,
    before: {
      openingAmount: session.openingAmount,
      openedBy: session.openedBy,
    },
    after: {
      id: session.id,
      closedBy: session.closedBy,
      countedAmount: session.countedAmount,
      expectedAmount: session.expectedAmount,
      difference: session.difference,
      notes: session.notes,
    },
  });

  revalidatePath('/dashboard/cash');
  return session;
}

export async function addCashMovement(
  type: CashMovementType,
  amount: number | string,
  reason: string,
  options?: { authorizedBy?: string | null },
): Promise<CashMovement> {
  const { userId, orgId } = await requireOrg();
  const actor = await getActorName(userId);

  if (type === 'sale') {
    throw new Error(
      'Los movimientos de tipo "sale" solo se crean automáticamente al registrar una venta',
    );
  }

  if (
    !INCOME_MOVEMENT_TYPES.includes(type)
    && !EXPENSE_MOVEMENT_TYPES.includes(type)
  ) {
    throw new Error(`Tipo de movimiento inválido: ${type}`);
  }

  const reasonTrimmed = reason?.trim();
  if (!reasonTrimmed) {
    throw new Error('Reason is required');
  }

  const amt = toMoney(amount);
  if (Number.parseFloat(amt) <= 0) {
    throw new Error('Amount must be > 0');
  }

  const movement = await db.transaction(async (tx) => {
    const open = await findOpenSession(tx, orgId);
    if (!open) {
      throw new Error('No hay caja abierta. Abre la caja primero.');
    }

    const [created] = await tx
      .insert(cashMovementsSchema)
      .values({
        sessionId: open.id,
        organizationId: orgId,
        type,
        amount: amt,
        reason: reasonTrimmed,
        createdBy: actor,
        authorizedBy: options?.authorizedBy ?? null,
      })
      .returning();

    if (!created) {
      throw new Error('Failed to register cash movement');
    }
    return created;
  });

  revalidatePath('/dashboard/cash');
  return movement;
}

export type GetCurrentCashResult = {
  session: CashSession | null;
  movements: CashMovement[];
  expected: number;
};

export async function getCurrentCash(): Promise<GetCurrentCashResult> {
  const { orgId } = await requireOrg();

  const session = await findOpenSession(db, orgId);
  if (!session) {
    return { session: null, movements: [], expected: 0 };
  }

  const [movements, expected] = await Promise.all([
    db
      .select()
      .from(cashMovementsSchema)
      .where(eq(cashMovementsSchema.sessionId, session.id))
      .orderBy(desc(cashMovementsSchema.createdAt)),
    computeExpectedAmount(db, session),
  ]);

  return { session, movements, expected };
}

export async function listCashSessions(limit = 30): Promise<CashSession[]> {
  const { orgId } = await requireOrg();
  const capped = Math.min(Math.max(limit, 1), 200);
  return db
    .select()
    .from(cashSessionsSchema)
    .where(eq(cashSessionsSchema.organizationId, orgId))
    .orderBy(desc(cashSessionsSchema.openedAt))
    .limit(capped);
}

export type FraudAlertKind
  = | 'high_discrepancy'
    | 'mid_discrepancy'
    | 'long_session'
    | 'sales_without_session';

export type FraudAlertSeverity = 'high' | 'mid' | 'low';

export type FraudAlert = {
  kind: FraudAlertKind;
  severity: FraudAlertSeverity;
  count: number;
  message: string;
};

export async function getFraudAlerts(days = 14): Promise<FraudAlert[]> {
  const { orgId } = await requireOrg();
  const safeDays = Math.min(Math.max(Math.floor(days) || 0, 1), 365);
  const interval = sql`(${safeDays}::text || ' days')::interval`;

  const recentSessions = await db
    .select({
      difference: cashSessionsSchema.difference,
      expectedAmount: cashSessionsSchema.expectedAmount,
    })
    .from(cashSessionsSchema)
    .where(
      and(
        eq(cashSessionsSchema.organizationId, orgId),
        eq(cashSessionsSchema.status, 'closed'),
        gte(cashSessionsSchema.closedAt, sql`now() - ${interval}`),
      ),
    );

  let highCount = 0;
  let midCount = 0;
  for (const row of recentSessions) {
    const diff = Math.abs(Number.parseFloat(row.difference ?? '0') || 0);
    const expected = Number.parseFloat(row.expectedAmount ?? '0') || 0;
    if (expected <= 0) {
      continue;
    }
    const ratio = diff / expected;
    if (ratio <= 0.05) {
      continue;
    }
    if (diff > 10000) {
      highCount++;
    } else if (diff > 2000) {
      midCount++;
    }
  }

  const [longRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(cashSessionsSchema)
    .where(
      and(
        eq(cashSessionsSchema.organizationId, orgId),
        eq(cashSessionsSchema.status, 'open'),
        lt(cashSessionsSchema.openedAt, sql`now() - interval '24 hours'`),
      ),
    );
  const longSessions = Number(longRow?.count ?? 0);

  const orphanResult = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM sales s
    WHERE s.organization_id = ${orgId}
      AND s.status = 'completed'
      AND s.created_at >= now() - ${interval}
      AND NOT EXISTS (
        SELECT 1 FROM cash_movements m WHERE m.sale_id = s.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM cash_sessions cs
        WHERE cs.organization_id = s.organization_id
          AND cs.opened_at <= s.created_at
          AND (cs.closed_at IS NULL OR cs.closed_at > s.created_at)
      )
  `);
  const orphanRow = (orphanResult.rows?.[0] ?? {}) as { count?: number | string };
  const orphanSales = Number(orphanRow.count ?? 0);

  const alerts: FraudAlert[] = [];
  if (highCount > 0) {
    alerts.push({
      kind: 'high_discrepancy',
      severity: 'high',
      count: highCount,
      message: `${highCount} cierre(s) de caja con diferencia mayor a $10.000 (>5%)`,
    });
  }
  if (midCount > 0) {
    alerts.push({
      kind: 'mid_discrepancy',
      severity: 'mid',
      count: midCount,
      message: `${midCount} cierre(s) de caja con diferencia entre $2.000 y $10.000 (>5%)`,
    });
  }
  if (longSessions > 0) {
    alerts.push({
      kind: 'long_session',
      severity: 'mid',
      count: longSessions,
      message: `${longSessions} caja(s) abierta(s) hace más de 24 horas`,
    });
  }
  if (orphanSales > 0) {
    alerts.push({
      kind: 'sales_without_session',
      severity: 'low',
      count: orphanSales,
      message: `${orphanSales} venta(s) registradas sin caja abierta en los últimos ${safeDays} días`,
    });
  }

  return alerts;
}
