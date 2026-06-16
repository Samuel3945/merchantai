import { auth } from '@clerk/nextjs/server';
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { formatSaleNumber } from '@/libs/sale-number';
import {
  cashMovementsSchema,
  cashSessionsSchema,
  fiadoMovementsSchema,
  salePaymentsSchema,
  salesSchema,
} from '@/models/Schema';

// ── Carry-over helper (extracted from treasury.ts#cajaBalance ELSE branch) ────

/**
 * Returns the carry-over expected amount for a POS session: the `countedAmount`
 * of the most recent CLOSED session for the given pos token, plus a boolean that
 * distinguishes "first open ever" from "last close was 0".
 *
 * The priorCloseExists flag is load-bearing: it drives explanation enforcement
 * in the open route — a legitimate prior close of 0 must still trigger enforcement
 * when the new count differs.
 */
// ── Open-time carry-over validation (pure) ───────────────────────────────────

/**
 * Validates whether a cash-session open request satisfies carry-over rules.
 *
 * Enforces explanation ONLY when:
 *   priorCloseExists === true AND counted !== expected AND explanation is blank.
 *
 * Returns either:
 *   { valid: true,  difference: number }   — proceed with insert
 *   { valid: false, code: 422, message: string } — reject request
 *
 * difference = counted − expected (signed: negative = shortfall, positive = surplus).
 */
export type ValidateOpenCarryoverInput = {
  priorCloseExists: boolean;
  counted: number;
  expected: number;
  explanation?: string | null;
};

export type ValidateOpenCarryoverResult =
  | { valid: true; difference: number }
  | { valid: false; code: 422; message: string };

export function validateOpenCarryover(
  input: ValidateOpenCarryoverInput,
): ValidateOpenCarryoverResult {
  const { priorCloseExists, counted, expected, explanation } = input;
  const difference = counted - expected;

  if (priorCloseExists && counted !== expected && !explanation?.trim()) {
    return {
      valid: false,
      code: 422,
      message: 'Explica la diferencia de apertura (opening_explanation requerida)',
    };
  }

  return { valid: true, difference };
}

export async function getOpeningExpected(
  executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  posTokenId: string,
): Promise<{ expected: number; priorCloseExists: boolean }> {
  const [last] = await executor
    .select({ counted: cashSessionsSchema.countedAmount })
    .from(cashSessionsSchema)
    .where(
      and(
        eq(cashSessionsSchema.organizationId, organizationId),
        eq(cashSessionsSchema.posTokenId, posTokenId),
        eq(cashSessionsSchema.status, 'closed'),
      ),
    )
    .orderBy(desc(cashSessionsSchema.closedAt))
    .limit(1);

  if (!last) {
    return { expected: 0, priorCloseExists: false };
  }
  return {
    expected: Number.parseFloat(last.counted ?? '0') || 0,
    priorCloseExists: true,
  };
}

export type CashSession = typeof cashSessionsSchema.$inferSelect;
export type CashMovement = typeof cashMovementsSchema.$inferSelect;
export type CashMovementType
  = (typeof cashMovementsSchema.type.enumValues)[number];

// ── POS wire shape ───────────────────────────────────────────────────────────
// The cashier device (pos-merchatai) reads snake_case session fields. POS cash
// endpoints must map to this explicit shape instead of returning the raw drizzle
// row (camelCase), the same way /pos/me maps its payload. Leaking the ORM row
// left the device reading opened_at / opening_amount as undefined ("Invalid
// Date" and a $0 opening float in the till header).
export type PosCashSessionWire = {
  id: string;
  opened_at: string;
  opened_by: string;
  opening_amount: number;
  closed_at: string | null;
  closed_by: string | null;
  expected_amount: number | null;
  counted_amount: number | null;
  difference: number | null;
  status: 'open' | 'closed';
  notes: string | null;
  // Open-time carry-over fields (Phase 3). Null for legacy sessions.
  opening_expected: number | null;
  opening_difference: number | null;
  opening_explanation: string | null;
};

export function toPosCashSession(s: CashSession): PosCashSessionWire {
  return {
    id: s.id,
    opened_at: s.openedAt.toISOString(),
    opened_by: s.openedBy,
    opening_amount: Number(s.openingAmount),
    closed_at: s.closedAt ? s.closedAt.toISOString() : null,
    closed_by: s.closedBy,
    expected_amount: s.expectedAmount == null ? null : Number(s.expectedAmount),
    counted_amount: s.countedAmount == null ? null : Number(s.countedAmount),
    difference: s.difference == null ? null : Number(s.difference),
    status: s.status,
    notes: s.notes,
    opening_expected: s.openingExpected == null ? null : Number(s.openingExpected),
    opening_difference: s.openingDifference == null ? null : Number(s.openingDifference),
    opening_explanation: s.openingExplanation ?? null,
  };
}

export const CASH_PAYMENT_METHODS = ['efectivo', 'cash'];

export function isCashMethod(method: string | null): boolean {
  const m = (method ?? '').trim().toLowerCase();
  return CASH_PAYMENT_METHODS.some(c => m.includes(c));
}

// Cash coming INTO the drawer. `adjustment` is a manual reconciliation entry
// that raises expected cash — it existed in the enum but was counted nowhere
// before, that gap is fixed here.
export const INCOME_MOVEMENT_TYPES: CashMovementType[] = [
  'sale',
  'deposit',
  'adjustment',
  // Cobro de fiado en efectivo: real cash into the drawer, so it raises the
  // expected amount for the arqueo. It is NOT revenue (Finanzas excludes it —
  // revenue was booked when the fiado sale happened), only drawer cash.
  'fiado_payment',
];

// Cash leaving the drawer. This DOES include `withdrawal`: a security withdrawal
// still removes physical cash from the register, so it belongs in the Caja
// "expected cash" calculation.
//
// Finanzas (analytics.ts, dashboard.ts) deliberately uses a NARROWER set —
// expense + salary + inventory_purchase — because a security withdrawal only
// relocates cash to a safe/bank and is not a P&L expense, `advance` (vale de
// empleado) is a receivable against future salary, and `adjustment` is a
// reconciliation entry, not a cost.
export const EXPENSE_MOVEMENT_TYPES: CashMovementType[] = [
  'expense',
  'salary',
  'inventory_purchase',
  'withdrawal',
  'advance',
];

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export function toMoney(value: number | string): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) {
    throw new TypeError('Invalid monetary value');
  }
  return n.toFixed(2);
}

// `posTokenId` scopes the lookup to a single POS device (caja):
//   - a UUID  → that device's own open session
//   - null    → the admin/legacy session (no device token)
//   - omitted → any open session for the org (legacy/admin callers, unchanged)
export async function findOpenSession(
  executor: Executor,
  organizationId: string,
  posTokenId?: string | null,
): Promise<CashSession | undefined> {
  const conds = [
    eq(cashSessionsSchema.organizationId, organizationId),
    eq(cashSessionsSchema.status, 'open'),
  ];
  if (posTokenId !== undefined) {
    conds.push(
      posTokenId === null
        ? isNull(cashSessionsSchema.posTokenId)
        : eq(cashSessionsSchema.posTokenId, posTokenId),
    );
  }
  const [session] = await executor
    .select()
    .from(cashSessionsSchema)
    .where(and(...conds))
    .orderBy(desc(cashSessionsSchema.openedAt))
    .limit(1);
  return session;
}

// Returns the org's open session for the device (null = admin/dashboard),
// auto-creating one with a zero opening float if none is open. The dashboard
// never asks the owner to "open" a caja — cajas open at the POS, and the panel's
// own session opens itself the moment a movement or correction needs to land.
export async function findOrCreateOpenSession(
  executor: Executor,
  args: {
    organizationId: string;
    openedBy: string;
    posTokenId?: string | null;
    notes?: string | null;
  },
): Promise<CashSession> {
  const existing = await findOpenSession(
    executor,
    args.organizationId,
    args.posTokenId ?? null,
  );
  if (existing) {
    return existing;
  }
  const [created] = await executor
    .insert(cashSessionsSchema)
    .values({
      organizationId: args.organizationId,
      posTokenId: args.posTokenId ?? null,
      openedBy: args.openedBy,
      openingAmount: '0',
      status: 'open',
      notes: args.notes ?? null,
    })
    .returning();
  if (!created) {
    throw new Error('No se pudo abrir la caja');
  }
  return created;
}

// A session is correctable only if it is already CLOSED and belongs to the org —
// you correct a past arqueo, never an open one.
export async function findCorrectableSession(
  executor: Executor,
  args: { sessionId: string; organizationId: string },
): Promise<CashSession | undefined> {
  const [session] = await executor
    .select()
    .from(cashSessionsSchema)
    .where(
      and(
        eq(cashSessionsSchema.id, args.sessionId),
        eq(cashSessionsSchema.organizationId, args.organizationId),
        eq(cashSessionsSchema.status, 'closed'),
      ),
    )
    .limit(1);
  return session;
}

// Posts a post-close correction: an 'adjustment' movement in the CURRENT session
// that references the original closed session. The original session's numbers are
// never touched — that immutability is what keeps the correction auditable and
// the cash-fraud signal intact (the original discrepancy survives, with how/when/
// by whom it was explained recorded alongside).
// `type` carries the direction the owner CHOSE: 'adjustment' raises the drawer
// (money that came in and wasn't recorded), 'expense' lowers it (money that went
// out and wasn't recorded). The system never infers it — the owner knows what
// really happened, and the correction can even widen the original gap (e.g. extra
// uncounted cash on top of a surplus).
export async function recordCorrectionMovement(
  executor: Executor,
  args: {
    organizationId: string;
    originalSessionId: string;
    currentSessionId: string;
    type: 'adjustment' | 'expense';
    amount: number | string;
    reason: string;
    createdBy: string;
  },
): Promise<CashMovement | null> {
  const [created] = await executor
    .insert(cashMovementsSchema)
    .values({
      sessionId: args.currentSessionId,
      organizationId: args.organizationId,
      type: args.type,
      amount: toMoney(args.amount),
      reason: args.reason,
      correctsSessionId: args.originalSessionId,
      createdBy: args.createdBy,
    })
    .returning();
  return created ?? null;
}

// Posts the signed cash delta of a payment reclassification into the CURRENT
// session (never edits the original sale movement, never touches a closed
// session). Negative = cash left the drawer because the payment was really a
// transfer; positive = the reverse.
export async function recordReclassificationMovement(
  executor: Executor,
  args: {
    organizationId: string;
    sessionId: string;
    amount: number | string;
    reason: string;
    saleId?: string | null;
    createdBy: string;
  },
): Promise<CashMovement | null> {
  const [created] = await executor
    .insert(cashMovementsSchema)
    .values({
      sessionId: args.sessionId,
      organizationId: args.organizationId,
      type: 'reclassification',
      amount: toMoney(args.amount),
      reason: args.reason,
      saleId: args.saleId ?? null,
      createdBy: args.createdBy,
    })
    .returning();
  return created ?? null;
}

export type CashBreakdown = {
  /** Base inicial — opening float entered when the session was opened. */
  opening: number;
  /** Ventas en efectivo de la sesión (type = sale). */
  cashSales: number;
  /** Entradas manuales: ingresos y ajustes (deposit + adjustment). */
  entradas: number;
  /** Salidas: todo el efectivo que salió del cajón (gastos + retiros). */
  salidas: number;
  /**
   * Reclasificaciones de método de pago, CON SIGNO: negativo cuando el efectivo
   * salió del cajón porque era transferencia, positivo al revés.
   */
  reclassifications: number;
  /** Efectivo esperado = opening + cashSales + entradas - salidas + reclassifications. */
  expected: number;
  /** Cantidad de movimientos de la sesión. */
  movementCount: number;
};

/**
 * Single source of truth for the Caja numbers. Answers the only question the
 * Caja screen cares about — how much cash should physically be in the register
 * right now — broken down so the header can show base / ventas / entradas /
 * salidas without recomputing on the client.
 */
export async function computeCashBreakdown(
  executor: Executor,
  session: Pick<CashSession, 'id' | 'openingAmount'>,
): Promise<CashBreakdown> {
  const [row] = await executor
    .select({
      cashSales: sql<string>`COALESCE(SUM(${cashMovementsSchema.amount}) FILTER (WHERE ${cashMovementsSchema.type} = 'sale'), 0)::text`,
      entradas: sql<string>`COALESCE(SUM(${cashMovementsSchema.amount}) FILTER (WHERE ${cashMovementsSchema.type} IN ('deposit','adjustment','fiado_payment')), 0)::text`,
      salidas: sql<string>`COALESCE(SUM(${cashMovementsSchema.amount}) FILTER (WHERE ${cashMovementsSchema.type} IN ('expense','salary','inventory_purchase','withdrawal','advance')), 0)::text`,
      // Signed: a reclassification can move expected cash either way.
      reclassifications: sql<string>`COALESCE(SUM(${cashMovementsSchema.amount}) FILTER (WHERE ${cashMovementsSchema.type} = 'reclassification'), 0)::text`,
      movementCount: sql<number>`COUNT(*)::int`,
    })
    .from(cashMovementsSchema)
    .where(eq(cashMovementsSchema.sessionId, session.id));

  const opening = Number.parseFloat(session.openingAmount) || 0;
  const cashSales = Number.parseFloat(row?.cashSales ?? '0') || 0;
  const entradas = Number.parseFloat(row?.entradas ?? '0') || 0;
  const salidas = Number.parseFloat(row?.salidas ?? '0') || 0;
  const reclassifications
    = Number.parseFloat(row?.reclassifications ?? '0') || 0;
  const expected = Number.parseFloat(
    (opening + cashSales + entradas - salidas + reclassifications).toFixed(2),
  );

  return {
    opening,
    cashSales,
    entradas,
    salidas,
    reclassifications,
    expected,
    movementCount: Number(row?.movementCount ?? 0),
  };
}

export async function computeExpectedAmount(
  executor: Executor,
  session: Pick<CashSession, 'id' | 'openingAmount'>,
): Promise<number> {
  const { expected } = await computeCashBreakdown(executor, session);
  return expected;
}

export async function recordCashMovement(
  saleId: string,
  total: number | string,
  ctx?: { organizationId: string; userId: string; posTokenId?: string | null },
): Promise<CashMovement | null> {
  let userId: string | undefined;
  let orgId: string | undefined;
  // Scope the till to the device that made the sale (null/omitted = admin/org).
  const posTokenId = ctx?.posTokenId;

  if (ctx) {
    userId = ctx.userId;
    orgId = ctx.organizationId;
  } else {
    const session = await auth();
    userId = session.userId ?? undefined;
    orgId = session.orgId ?? undefined;
  }

  if (!userId || !orgId) {
    return null;
  }

  // Auto-create a minimal session when cash enters the drawer so the cash is
  // always accounted for. No silent gaps that surface as unexplained surpluses
  // at closing time.
  let open = await findOpenSession(db, orgId, posTokenId);
  if (!open) {
    const [autoSession] = await db
      .insert(cashSessionsSchema)
      .values({
        organizationId: orgId,
        posTokenId: posTokenId ?? null,
        openedBy: userId,
        openingAmount: '0',
        status: 'open',
        notes: 'Auto-abierta por venta en efectivo (no había caja abierta)',
      })
      .returning();
    open = autoSession;
    if (!open) {
      return null;
    }
  }

  // One lookup feeds both the cash-detection fallback (paymentType) and the
  // human-readable movement label (saleNumber). Using the per-org sale number
  // keeps the Caja ledger consistent with the Sales view (#1001) instead of a
  // raw UUID prefix.
  const [sale] = await db
    .select({
      paymentType: salesSchema.paymentType,
      saleNumber: salesSchema.saleNumber,
    })
    .from(salesSchema)
    .where(eq(salesSchema.id, saleId))
    .limit(1);

  const [cashRow] = await db
    .select({
      sum: sql<string>`COALESCE(SUM(${salePaymentsSchema.amount}), 0)::text`,
    })
    .from(salePaymentsSchema)
    .where(
      and(
        eq(salePaymentsSchema.saleId, saleId),
        sql`LOWER(${salePaymentsSchema.method}) IN ('efectivo', 'cash')`,
      ),
    );

  let cashAmount = Number.parseFloat(cashRow?.sum ?? '0') || 0;

  if (cashAmount === 0) {
    const pt = sale?.paymentType?.toLowerCase();
    if (pt && CASH_PAYMENT_METHODS.includes(pt)) {
      cashAmount = Number.parseFloat(toMoney(total)) || 0;
    } else {
      return null;
    }
  }

  if (cashAmount <= 0) {
    return null;
  }

  const [created] = await db
    .insert(cashMovementsSchema)
    .values({
      sessionId: open.id,
      organizationId: orgId,
      type: 'sale',
      amount: toMoney(cashAmount),
      reason: `Venta ${formatSaleNumber(sale?.saleNumber ?? null)}`,
      createdBy: userId,
      saleId,
    })
    .returning();

  return created ?? null;
}

// ── Collections by payment method ────────────────────────────────────────────
// Caja shows the physical drawer (efectivo) — but the owner also wants to see
// how much came in by each digital method this session. Digital collections
// never enter the drawer, so they live in sale_payments + the fiado ledger, not
// cash_movements. This aggregates BOTH over the session window and buckets them.

export type CollectionsByMethod = {
  efectivo: number;
  transferencia: number;
  nequi: number;
  daviplata: number;
  otros: number;
  total: number;
};

export const EMPTY_COLLECTIONS: CollectionsByMethod = {
  efectivo: 0,
  transferencia: 0,
  nequi: 0,
  daviplata: 0,
  otros: 0,
  total: 0,
};

type CollectionBucket = keyof Omit<CollectionsByMethod, 'total'>;

function bucketForMethod(method: string | null): CollectionBucket {
  const m = (method ?? '').trim().toLowerCase();
  if (m.includes('efectivo') || m.includes('cash')) {
    return 'efectivo';
  }
  if (m.includes('nequi')) {
    return 'nequi';
  }
  if (m.includes('daviplata')) {
    return 'daviplata';
  }
  if (m.includes('transfer')) {
    return 'transferencia';
  }
  return 'otros';
}

function round2(n: number): number {
  return Number.parseFloat(n.toFixed(2));
}

export async function computeCollectionsByMethod(
  executor: Executor,
  session: Pick<CashSession, 'id' | 'openedAt' | 'closedAt' | 'organizationId'>,
): Promise<CollectionsByMethod> {
  const start = session.openedAt;
  const end = session.closedAt ?? new Date();

  const [saleRows, fiadoRows] = await Promise.all([
    // Sale collections (excluding the fiado-credit portion, which is not money in).
    executor
      .select({
        method: salePaymentsSchema.method,
        sum: sql<string>`COALESCE(SUM(${salePaymentsSchema.amount}), 0)::text`,
      })
      .from(salePaymentsSchema)
      .innerJoin(salesSchema, eq(salesSchema.id, salePaymentsSchema.saleId))
      .where(
        and(
          eq(salesSchema.organizationId, session.organizationId),
          gte(salePaymentsSchema.createdAt, start),
          lte(salePaymentsSchema.createdAt, end),
          sql`${salePaymentsSchema.method} NOT ILIKE '%fiado%'`,
        ),
      )
      .groupBy(salePaymentsSchema.method),
    // Fiado abonos collected this session.
    executor
      .select({
        method: fiadoMovementsSchema.method,
        sum: sql<string>`COALESCE(SUM(${fiadoMovementsSchema.amount}), 0)::text`,
      })
      .from(fiadoMovementsSchema)
      .where(
        and(
          eq(fiadoMovementsSchema.organizationId, session.organizationId),
          eq(fiadoMovementsSchema.type, 'payment'),
          gte(fiadoMovementsSchema.createdAt, start),
          lte(fiadoMovementsSchema.createdAt, end),
        ),
      )
      .groupBy(fiadoMovementsSchema.method),
  ]);

  const result: CollectionsByMethod = { ...EMPTY_COLLECTIONS };
  for (const row of [...saleRows, ...fiadoRows]) {
    const amount = Number.parseFloat(row.sum) || 0;
    if (amount === 0) {
      continue;
    }
    const bucket = bucketForMethod(row.method);
    result[bucket] = round2(result[bucket] + amount);
  }
  result.total = round2(
    result.efectivo
    + result.transferencia
    + result.nequi
    + result.daviplata
    + result.otros,
  );
  return result;
}
