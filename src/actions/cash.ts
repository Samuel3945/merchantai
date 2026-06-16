'use server';

import type { ActionResult } from '@/libs/action-result';
import type { CashBreakdown, CashMovement, CashMovementType, CashSession, CollectionsByMethod } from '@/libs/cash-helpers';
import type { CashRiskLevel } from '@/libs/cash-security-policy';
import { auth, currentUser } from '@clerk/nextjs/server';
import { and, desc, eq, getTableColumns, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { ActionValidationError } from '@/libs/action-result';
import { logAction } from '@/libs/audit-log';
import {
  computeCashBreakdown,
  computeCollectionsByMethod,
  computeExpectedAmount,
  EMPTY_COLLECTIONS,
  EXPENSE_MOVEMENT_TYPES,
  findCorrectableSession,
  findOpenSession,
  findOrCreateOpenSession,
  INCOME_MOVEMENT_TYPES,
  recordCorrectionMovement,
  toMoney,
} from '@/libs/cash-helpers';
import { recomputeAndCacheCashThreshold } from '@/libs/cash-security-engine';
import {
  CASH_SECURITY_POLICY,
  riskLevelForRatio,
} from '@/libs/cash-security-policy';
import { db } from '@/libs/DB';
import {
  cashMovementsSchema,
  cashSecurityThresholdCacheSchema,
  cashSessionsSchema,
  posTokensSchema,
  suppliersSchema,
  treasuryAccountsSchema,
  treasuryMovementsSchema,
} from '@/models/Schema';
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

export async function closeCashSession(
  countedAmount: number | string,
  notes?: string | null,
): Promise<ActionResult<CashSession>> {
  const { userId, orgId } = await requireOrg();
  const actor = await getActorName(userId);

  const counted = toMoney(countedAmount);

  let session: CashSession;
  try {
    session = await db.transaction(async (tx) => {
      const open = await findOpenSession(tx, orgId, null);
      if (!open) {
        throw new ActionValidationError('No hay caja abierta para cerrar');
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
  } catch (error) {
    if (error instanceof ActionValidationError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }

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
  return { ok: true, data: session };
}

export async function addCashMovement(
  type: CashMovementType,
  amount: number | string,
  reason: string,
  options?: {
    authorizedBy?: string | null;
    category?: string | null;
    supplierId?: string | null;
    // 2C: optional container selector for dual-write to treasury_movements.
    // toAccountId: for entrada (cash IN to a container — e.g. security withdrawal to vault).
    // fromAccountId: for salida (cash OUT from a container).
    // When provided, a companion treasury_movements row is inserted in the same tx.
    // When omitted, only cash_movements is written (backward compatible).
    toAccountId?: string | null;
    fromAccountId?: string | null;
  },
): Promise<ActionResult<CashMovement>> {
  const { userId, orgId } = await requireOrg();
  const actor = await getActorName(userId);

  if (type === 'sale') {
    return {
      ok: false,
      error:
        'Los movimientos de tipo "sale" solo se crean automáticamente al registrar una venta',
    };
  }

  if (
    !INCOME_MOVEMENT_TYPES.includes(type)
    && !EXPENSE_MOVEMENT_TYPES.includes(type)
  ) {
    return { ok: false, error: `Tipo de movimiento inválido: ${type}` };
  }

  const reasonTrimmed = reason?.trim();
  if (!reasonTrimmed) {
    return { ok: false, error: 'El motivo es obligatorio' };
  }

  const amt = toMoney(amount);
  if (Number.parseFloat(amt) <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }

  // Supplier link is optional, but when present it must be a real, active
  // supplier of this org — guards against stale or cross-tenant ids.
  const supplierId = options?.supplierId ?? null;
  if (supplierId) {
    const [supplier] = await db
      .select({ id: suppliersSchema.id })
      .from(suppliersSchema)
      .where(
        and(
          eq(suppliersSchema.id, supplierId),
          eq(suppliersSchema.organizationId, orgId),
          eq(suppliersSchema.status, 'active'),
        ),
      )
      .limit(1);
    if (!supplier) {
      return {
        ok: false,
        error: 'El proveedor seleccionado no existe o está archivado',
      };
    }
  }

  // 2C: Resolve optional container account for the dual-write.
  // toAccountId is used for security withdrawals (cash enters vault/container).
  // fromAccountId is used for entradas from outside a container.
  const toAccountId = options?.toAccountId ?? null;
  const fromAccountId = options?.fromAccountId ?? null;
  const hasTreasuryDualWrite = toAccountId !== null || fromAccountId !== null;

  // Pre-flight validation: fast-fail before opening a transaction when the
  // container id is obviously invalid. This is a UX guard only — the authoritative
  // active-status check runs INSIDE the transaction (see below) so a container
  // deactivated between this check and the commit still rolls back both writes.
  if (hasTreasuryDualWrite) {
    const accountId = (toAccountId ?? fromAccountId)!;
    const [container] = await db
      .select({ id: treasuryAccountsSchema.id, active: treasuryAccountsSchema.active })
      .from(treasuryAccountsSchema)
      .where(
        and(
          eq(treasuryAccountsSchema.id, accountId),
          eq(treasuryAccountsSchema.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!container || !container.active) {
      return {
        ok: false,
        error: 'El contenedor seleccionado no existe o está inactivo',
      };
    }
  }

  let movement: CashMovement;
  try {
    movement = await db.transaction(async (tx) => {
      // The dashboard caja opens itself on the first movement — the owner never
      // opens it explicitly (cajas open at the POS).
      const open = await findOrCreateOpenSession(tx, {
        organizationId: orgId,
        openedBy: actor,
      });

      const [created] = await tx
        .insert(cashMovementsSchema)
        .values({
          sessionId: open.id,
          organizationId: orgId,
          type,
          amount: amt,
          reason: reasonTrimmed,
          category: options?.category?.trim() || null,
          supplierId,
          createdBy: actor,
          authorizedBy: options?.authorizedBy ?? null,
        })
        .returning();

      if (!created) {
        throw new Error('Failed to register cash movement');
      }

      // 2C dual-write: companion treasury_movements row in the same transaction.
      // cash_movements is the caja ledger (unchanged); treasury_movements is the
      // container ledger (new). The two reads are disjoint — no double count.
      if (hasTreasuryDualWrite) {
        // W-2 hardening: re-validate the container is still active INSIDE the
        // transaction. If the container was deactivated between the pre-flight
        // check above and this point, throwing here rolls back BOTH the
        // cash_movements insert and the treasury_movements insert atomically.
        const txAccountId = (toAccountId ?? fromAccountId)!;
        const [txContainer] = await tx
          .select({ id: treasuryAccountsSchema.id, active: treasuryAccountsSchema.active })
          .from(treasuryAccountsSchema)
          .where(
            and(
              eq(treasuryAccountsSchema.id, txAccountId),
              eq(treasuryAccountsSchema.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!txContainer || !txContainer.active) {
          throw new ActionValidationError(
            'El contenedor seleccionado no existe o está inactivo',
          );
        }

        // Determine movement direction:
        //   toAccountId set   → cash entering a container (entrada): from=null, to=container
        //   fromAccountId set → cash leaving a container (salida):   from=container, to=null
        const treasuryType = toAccountId !== null ? 'entrada' : 'salida';
        await tx
          .insert(treasuryMovementsSchema)
          .values({
            organizationId: orgId,
            fromAccountId,
            toAccountId,
            amount: amt,
            type: treasuryType,
            reason: reasonTrimmed,
            createdBy: actor,
          });
      }

      return created;
    });
  } catch (error) {
    if (error instanceof ActionValidationError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }

  revalidatePath('/dashboard/cash');
  return { ok: true, data: movement };
}

// Post-close correction of an ALREADY-CLOSED session, without editing that
// arqueo. The OWNER chooses the direction (the system never infers it): 'in'
// records money that came in and was missed (raises), 'out' records money that
// went out and was missed (lowers). It posts to the current open session,
// referencing the closed one; the original difference stays for the fraud
// analysis, with this correction (direction, amount, reason, who, when) linked.
export async function recordCashCorrection(
  originalSessionId: string,
  direction: 'in' | 'out',
  amount: number | string,
  reason: string,
): Promise<ActionResult<CashMovement>> {
  const { userId, orgId } = await requireOrg();
  const actor = await getActorName(userId);

  const reasonTrimmed = reason?.trim();
  if (!reasonTrimmed) {
    return { ok: false, error: 'El motivo es obligatorio' };
  }
  const type = direction === 'in' ? 'adjustment' : 'expense';
  const amt = toMoney(amount);
  if (Number.parseFloat(amt) <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }

  let movement: CashMovement;
  try {
    movement = await db.transaction(async (tx) => {
      const original = await findCorrectableSession(tx, {
        sessionId: originalSessionId,
        organizationId: orgId,
      });
      if (!original) {
        throw new ActionValidationError(
          'La sesión a corregir no existe o no está cerrada',
        );
      }
      const open = await findOrCreateOpenSession(tx, {
        organizationId: orgId,
        openedBy: actor,
      });
      const created = await recordCorrectionMovement(tx, {
        organizationId: orgId,
        originalSessionId,
        currentSessionId: open.id,
        type,
        amount: amt,
        reason: reasonTrimmed,
        createdBy: actor,
      });
      if (!created) {
        throw new Error('No se pudo registrar la corrección');
      }
      return created;
    });
  } catch (error) {
    if (error instanceof ActionValidationError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'cash.correction',
    entityType: 'cash_movement',
    entityId: movement.id,
    after: {
      correctsSessionId: movement.correctsSessionId,
      amount: movement.amount,
      reason: movement.reason,
    },
  });
  revalidatePath('/dashboard/cash');
  return { ok: true, data: movement };
}

const EMPTY_BREAKDOWN: CashBreakdown = {
  opening: 0,
  cashSales: 0,
  entradas: 0,
  salidas: 0,
  reclassifications: 0,
  expected: 0,
  movementCount: 0,
};

export type GetCurrentCashResult = {
  session: CashSession | null;
  movements: CashMovement[];
  expected: number;
  breakdown: CashBreakdown;
  collections: CollectionsByMethod;
};

export async function getCurrentCash(): Promise<GetCurrentCashResult> {
  const { orgId } = await requireOrg();

  const session = await findOpenSession(db, orgId, null);
  if (!session) {
    return {
      session: null,
      movements: [],
      expected: 0,
      breakdown: EMPTY_BREAKDOWN,
      collections: EMPTY_COLLECTIONS,
    };
  }

  const [movements, breakdown, collections] = await Promise.all([
    db
      .select()
      .from(cashMovementsSchema)
      .where(eq(cashMovementsSchema.sessionId, session.id))
      .orderBy(desc(cashMovementsSchema.createdAt)),
    computeCashBreakdown(db, session),
    computeCollectionsByMethod(db, session),
  ]);

  return {
    session,
    movements,
    expected: breakdown.expected,
    breakdown,
    collections,
  };
}

export type OpenCaja = {
  id: string;
  posTokenId: string | null;
  deviceName: string | null;
  openedBy: string;
  openedAt: string;
  openingAmount: number;
  expected: number;
  movementCount: number;
  // Timestamp of the most recent movement in the session, or openedAt when the
  // session has no movements yet. Drives "última actividad" on the caja card.
  lastActivityAt: string;
};

/**
 * Every currently-open POS-device till (one per caja). Read-only overview so the
 * owner can watch each cashier's caja without touching it. The dashboard/admin
 * session (posTokenId = null) is intentionally excluded — it is a movement
 * container the owner opens implicitly, NOT a real point of sale, so it must not
 * surface as a "caja" in the supervision view.
 */
export async function listOpenCajas(): Promise<OpenCaja[]> {
  const { orgId } = await requireOrg();
  const rows = await db
    .select({
      id: cashSessionsSchema.id,
      posTokenId: cashSessionsSchema.posTokenId,
      openedBy: cashSessionsSchema.openedBy,
      openedAt: cashSessionsSchema.openedAt,
      openingAmount: cashSessionsSchema.openingAmount,
      deviceName: posTokensSchema.deviceName,
    })
    .from(cashSessionsSchema)
    .leftJoin(
      posTokensSchema,
      eq(posTokensSchema.id, cashSessionsSchema.posTokenId),
    )
    .where(
      and(
        eq(cashSessionsSchema.organizationId, orgId),
        eq(cashSessionsSchema.status, 'open'),
        // Only POS-device cajas — never the implicit dashboard/admin session.
        isNotNull(cashSessionsSchema.posTokenId),
      ),
    )
    .orderBy(desc(cashSessionsSchema.openedAt));

  return Promise.all(
    rows.map(async (r) => {
      const [expected, countRows] = await Promise.all([
        computeExpectedAmount(db, {
          id: r.id,
          openingAmount: r.openingAmount,
        }),
        db
          .select({
            c: sql<number>`count(*)::int`,
            lastAt: sql<string | null>`max(${cashMovementsSchema.createdAt})`,
          })
          .from(cashMovementsSchema)
          .where(eq(cashMovementsSchema.sessionId, r.id)),
      ]);
      const lastAt = countRows[0]?.lastAt;
      return {
        id: r.id,
        posTokenId: r.posTokenId,
        deviceName: r.deviceName,
        openedBy: r.openedBy,
        openedAt: r.openedAt.toISOString(),
        openingAmount: Number(r.openingAmount),
        expected,
        movementCount: countRows[0]?.c ?? 0,
        lastActivityAt: lastAt
          ? new Date(lastAt).toISOString()
          : r.openedAt.toISOString(),
      };
    }),
  );
}

export type CajaDetail = {
  posTokenId: string;
  deviceName: string | null;
  status: 'open' | 'closed';
  responsable: string | null;
  openedAt: string | null;
  expected: number;
  lastActivityAt: string | null;
  movements: CashMovement[];
  closures: CashSession[];
};

/**
 * Per-caja (POS device) detail for the supervision drill-down. Returns the
 * device's current open session header plus its FULL ledger — every movement and
 * every past closure for that device, filtered to this caja only. Returns null
 * when the device does not belong to the caller's org.
 */
export async function getCajaDetail(
  posTokenId: string,
): Promise<CajaDetail | null> {
  const { orgId } = await requireOrg();

  const [device] = await db
    .select({
      id: posTokensSchema.id,
      deviceName: posTokensSchema.deviceName,
    })
    .from(posTokensSchema)
    .where(
      and(
        eq(posTokensSchema.id, posTokenId),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!device) {
    return null;
  }

  const [openSession, movements, closures] = await Promise.all([
    db
      .select()
      .from(cashSessionsSchema)
      .where(
        and(
          eq(cashSessionsSchema.organizationId, orgId),
          eq(cashSessionsSchema.posTokenId, posTokenId),
          eq(cashSessionsSchema.status, 'open'),
        ),
      )
      .orderBy(desc(cashSessionsSchema.openedAt))
      .limit(1),
    // Full movement ledger for this caja, across all its sessions.
    db
      .select(getTableColumns(cashMovementsSchema))
      .from(cashMovementsSchema)
      .innerJoin(
        cashSessionsSchema,
        eq(cashSessionsSchema.id, cashMovementsSchema.sessionId),
      )
      .where(
        and(
          eq(cashSessionsSchema.organizationId, orgId),
          eq(cashSessionsSchema.posTokenId, posTokenId),
        ),
      )
      .orderBy(desc(cashMovementsSchema.createdAt))
      .limit(1000),
    // Past closures (arqueos) of this caja.
    db
      .select()
      .from(cashSessionsSchema)
      .where(
        and(
          eq(cashSessionsSchema.organizationId, orgId),
          eq(cashSessionsSchema.posTokenId, posTokenId),
          eq(cashSessionsSchema.status, 'closed'),
        ),
      )
      .orderBy(desc(cashSessionsSchema.openedAt))
      .limit(200),
  ]);

  const session = openSession[0] ?? null;
  const expected = session
    ? await computeExpectedAmount(db, {
        id: session.id,
        openingAmount: session.openingAmount,
      })
    : 0;

  const lastMovementAt = movements[0]?.createdAt ?? null;
  const lastActivityAt = lastMovementAt
    ? new Date(lastMovementAt).toISOString()
    : session?.openedAt.toISOString() ?? null;

  return {
    posTokenId,
    deviceName: device.deviceName,
    status: session ? 'open' : 'closed',
    responsable: session?.openedBy ?? null,
    openedAt: session?.openedAt.toISOString() ?? null,
    expected,
    lastActivityAt,
    movements,
    closures,
  };
}

export async function listCashSessions(limit = 30): Promise<CashSession[]> {
  const { orgId } = await requireOrg();
  const capped = Math.min(Math.max(limit, 1), 5000);
  return db
    .select()
    .from(cashSessionsSchema)
    .where(eq(cashSessionsSchema.organizationId, orgId))
    .orderBy(desc(cashSessionsSchema.openedAt))
    .limit(capped);
}

/**
 * Full cash-movement ledger for the org, across every session — never deleted,
 * so this is the permanent audit trail the Caja history view filters over. Capped
 * high enough to cover a long history while staying a single, snappy query; the
 * history UI filters this set client-side (by date, responsable, entrada/salida).
 */
export async function listAllCashMovements(limit = 1000): Promise<CashMovement[]> {
  const { orgId } = await requireOrg();
  const capped = Math.min(Math.max(limit, 1), 5000);
  return db
    .select()
    .from(cashMovementsSchema)
    .where(eq(cashMovementsSchema.organizationId, orgId))
    .orderBy(desc(cashMovementsSchema.createdAt))
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

export type TodayCashKpis = {
  /** Gastos de tipo `expense` del día (gasto menor, proveedor, devolución…). */
  gastosHoy: number;
  /** Retiros de seguridad del día (type = withdrawal). */
  retirosHoy: number;
  /** Pagos a proveedores del día (movimientos con supplier_id). */
  pagosProveedores: number;
  /** Gastos operativos P&L del día (expense + salary + inventory_purchase). */
  gastosOperativos: number;
};

// Same-day (America/Bogota) financial snapshot for the Caja header KPIs. Derived
// live from the cash ledger — the single source of truth — and scoped to today
// across whatever sessions ran, not to a single open session.
export async function getTodayCashKpis(): Promise<TodayCashKpis> {
  const { orgId } = await requireOrg();

  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)::float8 AS gastos_hoy,
      COALESCE(SUM(amount) FILTER (WHERE type = 'withdrawal'), 0)::float8 AS retiros_hoy,
      COALESCE(SUM(amount) FILTER (WHERE supplier_id IS NOT NULL), 0)::float8 AS pagos_proveedores,
      COALESCE(SUM(amount) FILTER (WHERE type IN ('expense','salary','inventory_purchase')), 0)::float8 AS gastos_operativos
    FROM cash_movements
    WHERE organization_id = ${orgId}
      AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          = (now() AT TIME ZONE 'America/Bogota')::date
  `);

  const row = (result.rows?.[0] ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    gastosHoy: num(row.gastos_hoy),
    retirosHoy: num(row.retiros_hoy),
    pagosProveedores: num(row.pagos_proveedores),
    gastosOperativos: num(row.gastos_operativos),
  };
}

export type CashSecurityStatus = {
  /** `learning` while there isn't enough history to recommend a threshold. */
  state: 'learning' | 'ready';
  level: CashRiskLevel;
  threshold: number;
  currentCash: number;
  ratio: number;
  daysOperated: number;
  reasoning: string;
};

// Reads the cached behavioural threshold (computing it on-demand the first time)
// and compares it to the cash currently in the open drawer to derive the risk
// level. See cash-security-policy / cash-security-engine for the rules.
export async function getCashSecurityStatus(): Promise<CashSecurityStatus> {
  const { orgId } = await requireOrg();

  const session = await findOpenSession(db, orgId);
  const currentCash = session
    ? (await computeCashBreakdown(db, session)).expected
    : 0;

  async function readCache() {
    const [row] = await db
      .select()
      .from(cashSecurityThresholdCacheSchema)
      .where(eq(cashSecurityThresholdCacheSchema.organizationId, orgId))
      .limit(1);
    return row;
  }

  let cache = await readCache();
  if (!cache) {
    await recomputeAndCacheCashThreshold(orgId);
    cache = await readCache();
  }

  const daysOperated = cache?.daysOperated ?? 0;
  const threshold = Number.parseFloat(cache?.threshold ?? '0') || 0;
  const reasoning
    = (cache?.payload as { reasoning?: string } | null)?.reasoning ?? '';

  if (daysOperated < CASH_SECURITY_POLICY.minOperatingDays || threshold <= 0) {
    return {
      state: 'learning',
      level: 'normal',
      threshold,
      currentCash,
      ratio: 0,
      daysOperated,
      reasoning,
    };
  }

  const ratio = currentCash / threshold;
  return {
    state: 'ready',
    level: riskLevelForRatio(ratio),
    threshold,
    currentCash,
    ratio,
    daysOperated,
    reasoning,
  };
}
