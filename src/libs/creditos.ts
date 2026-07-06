import type { CreditoDueState } from '@/libs/creditos-shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { normalizeWhatsapp } from '@/features/customers/validation';
import { findOpenSession } from '@/libs/cash-helpers';
import {
  clientKeyOf,
  isCreditoMethod,
  normalizeClientKey,
  parseClient,
  planAbono,
  round2,
} from '@/libs/creditos-math';
import {
  addDaysISO,
  deriveDueState,
} from '@/libs/creditos-shared';
import { db } from '@/libs/DB';
import {
  createCreditoTransferReconciliation,
  methodNeedsReconciliation,
} from '@/libs/transfer-reconciliation';
import {
  appSettingsSchema,
  cashMovementsSchema,
  cashSessionsSchema,
  creditoMovementsSchema,
  creditosSchema,
  posUsersSchema,
  transferReconciliationsSchema,
} from '@/models/Schema';

export {
  addDaysISO,
  CREDITO_PAYMENT_METHODS,
  type CreditoDueState,
  daysUntilDue,
  deriveDueState,
  DUE_SOON_DAYS,
} from '@/libs/creditos-shared';
// Re-exported so the POS endpoints and the dashboard share one identity logic.
export { clientKeyOf, normalizeClientKey, parseClient };

// Core creditos (store-credit / accounts-receivable) service. Single source of
// truth for the money + ledger logic, kept out of the 'use server' action layer
// so it can run INSIDE a sale transaction (executor-aware) and be unit-reasoned
// without Clerk. The actions in actions/creditos.ts are thin auth+revalidate wrappers.
//
// Model (see models/Schema.ts): one `creditos` row per credit sale; an append-only
// `credito_movements` ledger (charge/payment/extension/writeoff/adjustment) that is
// the timeline, the Caja link and the audit trail. The UI groups creditos BY CLIENT
// because that is how a tendero thinks ("¿quién me debe?").

// Exported for integration tests (pglite executor).
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_TERM_DAYS = 30;
export const TERM_SETTING_KEY = 'creditos-default-term-days';

// Methods that physically enter the cash drawer. Only these create a Caja
// movement; digital abonos are collected but never touch the arqueo.
const CASH_METHODS = new Set(['efectivo', 'cash']);

// ── Money + identity helpers ─────────────────────────────────────────────────

export function toMoney(value: number | string): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) {
    throw new TypeError('Invalid monetary value');
  }
  return n.toFixed(2);
}

export function isCashMethod(method: string): boolean {
  return CASH_METHODS.has(method.trim().toLowerCase());
}

export async function getDefaultTermDays(
  executor: Executor,
  organizationId: string,
): Promise<number> {
  const [row] = await executor
    .select({ value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, organizationId),
        eq(appSettingsSchema.key, TERM_SETTING_KEY),
      ),
    )
    .limit(1);
  const n = Number.parseInt(row?.value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TERM_DAYS;
}

// ── Write: create a credito from a sale ────────────────────────────────────────

export type CreateCreditoArgs = {
  organizationId: string;
  saleId: string;
  originalAmount: number | string;
  // 'YYYY-MM-DD'. When omitted, computed from the org default term.
  dueDate?: string | null;
  customerId?: string | null;
  createdBy?: string | null;
  // The "Cliente: NAME | Tel: PHONE" display string (usually the sale notes).
  notes?: string | null;
  // Align the charge movement (and the credito) with the original sale time, for
  // the offline POS sync path that replays older sales.
  createdAt?: Date;
};

// Inserts the credito account + its opening `charge` movement. Runs inside the
// sale transaction (pass the tx as executor). Returns null for a zero amount.
export async function createCredito(
  executor: Executor,
  args: CreateCreditoArgs,
): Promise<{ id: string } | null> {
  const amount = toMoney(args.originalAmount);
  if (Number.parseFloat(amount) <= 0) {
    return null;
  }

  let dueDate = args.dueDate ?? null;
  if (!dueDate) {
    const term = await getDefaultTermDays(executor, args.organizationId);
    dueDate = addDaysISO(args.createdAt ?? new Date(), term);
  }

  const [credito] = await executor
    .insert(creditosSchema)
    .values({
      organizationId: args.organizationId,
      customerId: args.customerId ?? null,
      saleId: args.saleId,
      originalAmount: amount,
      dueDate,
      status: 'pending',
      notes: args.notes ?? null,
      createdBy: args.createdBy ?? null,
      ...(args.createdAt
        ? { createdAt: args.createdAt, updatedAt: args.createdAt }
        : {}),
    })
    // Idempotent against the partial unique on sale_id: a re-played sale never
    // spawns a second credito.
    .onConflictDoNothing()
    .returning({ id: creditosSchema.id });

  if (!credito) {
    return null;
  }

  await executor.insert(creditoMovementsSchema).values({
    creditoId: credito.id,
    organizationId: args.organizationId,
    type: 'charge',
    amount,
    note: 'Venta fiada',
    createdBy: args.createdBy ?? null,
    ...(args.createdAt ? { createdAt: args.createdAt } : {}),
  });

  return credito;
}

// ── Write: create an EMPLOYEE-LOAN credito (vale / préstamo) ──────────────────
//
// A vale is a real credito owed BY the employee: customerId / saleId stay null,
// employeeId is set, and notes carries the employee name so the wall shows it
// even without a customer FK. Mirrors createCredito but needs no sale. Runs
// inside the POS movement tx, funded by the `advance` cash_movements salida whose
// id is threaded in as cashMovementId on the opening `charge` movement.

export type CreateEmployeeLoanCreditoArgs = {
  organizationId: string;
  employeeId: string;
  employeeName: string | null;
  amount: number | string;
  // The `advance` cash_movements row that funded the loan (drawer outflow).
  cashMovementId: string | null;
  createdBy?: string | null;
  // 'YYYY-MM-DD'. Defaults to today + DEFAULT_TERM_DAYS.
  dueDate?: string | null;
};

export async function createEmployeeLoanCredito(
  executor: Executor,
  args: CreateEmployeeLoanCreditoArgs,
): Promise<{ id: string }> {
  const amount = toMoney(args.amount);
  if (Number.parseFloat(amount) <= 0) {
    throw new Error('El monto del préstamo debe ser mayor a 0');
  }

  const dueDate = args.dueDate ?? addDaysISO(new Date(), DEFAULT_TERM_DAYS);

  const [credito] = await executor
    .insert(creditosSchema)
    .values({
      organizationId: args.organizationId,
      customerId: null,
      saleId: null,
      employeeId: args.employeeId,
      originalAmount: amount,
      dueDate,
      status: 'pending',
      // The name snapshot doubles as the wall display name (no customer FK).
      notes: args.employeeName ?? null,
      createdBy: args.createdBy ?? null,
    })
    .returning({ id: creditosSchema.id });

  if (!credito) {
    throw new Error('No se pudo registrar el préstamo');
  }

  await executor.insert(creditoMovementsSchema).values({
    creditoId: credito.id,
    organizationId: args.organizationId,
    type: 'charge',
    amount,
    note: 'Préstamo a empleado',
    cashMovementId: args.cashMovementId,
    createdBy: args.createdBy ?? null,
  });

  return credito;
}

// ── Write: register an abono (payment) for a client ──────────────────────────

export type RecordAbonoArgs = {
  organizationId: string;
  // Groups the client's creditos (see clientKeyOf).
  clientKey: string;
  amount: number | string;
  method: string;
  note?: string | null;
  // User/cashier id, for the ledger audit and the Caja movement.
  createdBy: string;
};

export type RecordAbonoResult = {
  applied: number;
  remaining: number;
  paidCreditoIds: string[];
  cashMovementId: string | null;
  // True when the cash hit the drawer; false for digital, or cash with no open
  // Caja session (the abono is still recorded, the drawer just can't reflect it).
  hitCaja: boolean;
};

// Applies an abono FIFO across the client's pending creditos (oldest due first).
// A single Caja movement is created for the cash portion and linked to every
// payment movement it covers; digital methods are recorded with no drawer impact.
export async function recordAbono(
  args: RecordAbonoArgs,
): Promise<RecordAbonoResult> {
  return db.transaction(tx => recordAbonoTx(tx, args));
}

// Transaction body, exported for integration tests. recordAbono wraps it in
// db.transaction; tests drive it against a real Postgres engine (pglite).
export async function recordAbonoTx(
  executor: Executor,
  args: RecordAbonoArgs,
): Promise<RecordAbonoResult> {
  const amt = Number.parseFloat(toMoney(args.amount));
  if (amt <= 0) {
    throw new Error('El abono debe ser mayor a 0');
  }
  const method = args.method?.trim();
  if (!method) {
    throw new Error('Método de pago requerido');
  }
  if (isCreditoMethod(method)) {
    throw new Error('El abono no puede ser de tipo credito');
  }

  // Scan the org's pending creditos (no lock) to find the client's IDs,
  // oldest-due-first. Then lock only those rows — avoids serializing
  // unrelated clients' abonos in the same org.
  const candidates = await executor
    .select({
      id: creditosSchema.id,
      customerId: creditosSchema.customerId,
      employeeId: creditosSchema.employeeId,
      notes: creditosSchema.notes,
      originalAmount: creditosSchema.originalAmount,
    })
    .from(creditosSchema)
    .where(
      and(
        eq(creditosSchema.organizationId, args.organizationId),
        eq(creditosSchema.status, 'pending'),
      ),
    )
    .orderBy(asc(creditosSchema.dueDate), asc(creditosSchema.createdAt));

  const clientIds = candidates
    .filter(f => clientKeyOf(f) === args.clientKey)
    .map(f => f.id);
  if (clientIds.length === 0) {
    throw new Error('No se encontraron creditos pendientes para este cliente');
  }

  // Lock only the client's rows — not the whole org.
  const client = await executor
    .select({
      id: creditosSchema.id,
      customerId: creditosSchema.customerId,
      employeeId: creditosSchema.employeeId,
      notes: creditosSchema.notes,
      originalAmount: creditosSchema.originalAmount,
    })
    .from(creditosSchema)
    .where(inArray(creditosSchema.id, clientIds))
    .orderBy(asc(creditosSchema.dueDate), asc(creditosSchema.createdAt))
    .for('update');

  const ids = client.map(f => f.id);
  const paidRows = await executor
    .select({
      creditoId: creditoMovementsSchema.creditoId,
      paid: sql<string>`COALESCE(SUM(${creditoMovementsSchema.amount}), 0)::text`,
    })
    .from(creditoMovementsSchema)
    .where(
      and(
        inArray(creditoMovementsSchema.creditoId, ids),
        eq(creditoMovementsSchema.type, 'payment'),
      ),
    )
    .groupBy(creditoMovementsSchema.creditoId);
  const paidById = new Map(
    paidRows.map(r => [r.creditoId, Number.parseFloat(r.paid) || 0]),
  );

  const displayName = parseClient(client[0]?.notes ?? null).name || 'cliente';

  // Plan the FIFO distribution before writing anything. The math is pure and
  // unit-tested in creditos-math; here we only feed it balances and apply it.
  const { entries: plan, appliedTotal, remaining } = planAbono(
    client.map(f => ({
      id: f.id,
      balance: round2(
        (Number.parseFloat(f.originalAmount) || 0) - (paidById.get(f.id) ?? 0),
      ),
    })),
    amt,
  );

  // One Caja movement for the whole cash portion. If no session is open, a
  // minimal one is auto-created so the cash is always accounted for — no silent
  // gaps that surface as unexplained surpluses at closing time.
  let cashMovementId: string | null = null;
  if (isCashMethod(method) && appliedTotal > 0) {
    let session = await findOpenSession(executor, args.organizationId);
    if (!session) {
      const [autoSession] = await executor
        .insert(cashSessionsSchema)
        .values({
          organizationId: args.organizationId,
          openedBy: args.createdBy,
          openingAmount: '0',
          status: 'open',
          notes: 'Auto-abierta por cobro de credito (no había caja abierta)',
        })
        .returning();
      session = autoSession;
    }
    if (session) {
      const [cm] = await executor
        .insert(cashMovementsSchema)
        .values({
          sessionId: session.id,
          organizationId: args.organizationId,
          type: 'credito_payment',
          amount: toMoney(appliedTotal),
          reason: `Cobro de credito ${displayName}`.trim(),
          createdBy: args.createdBy,
        })
        .returning({ id: cashMovementsSchema.id });
      cashMovementId = cm?.id ?? null;
    }
  }

  // Digital abono (nequi/daviplata/transferencia): never touches the drawer, so
  // it gets ONE reconciliation row for the whole transfer (linked to every
  // credito_movement it covers), mirroring how the cash portion gets one
  // cash_movement. The owner confirms it against the account later.
  let transferReconciliationId: string | null = null;
  if (
    !isCashMethod(method)
    && appliedTotal > 0
    && methodNeedsReconciliation(method)
  ) {
    const session = await findOpenSession(executor, args.organizationId);
    transferReconciliationId = await createCreditoTransferReconciliation(
      executor,
      {
        organizationId: args.organizationId,
        method,
        expectedAmount: appliedTotal,
        cashSessionId: session?.id ?? null,
      },
    );
  }

  const paidCreditoIds: string[] = [];
  for (const p of plan) {
    if (p.apply > 0) {
      await executor.insert(creditoMovementsSchema).values({
        creditoId: p.creditoId,
        organizationId: args.organizationId,
        type: 'payment',
        amount: toMoney(p.apply),
        method,
        cashMovementId,
        transferReconciliationId,
        note: args.note ?? null,
        createdBy: args.createdBy,
      });
    }
    // A pending transfer abono does NOT settle the debt: the money hasn't landed
    // until the cashier confirms it in caja. Those creditos settle later, in
    // settleCreditosForConfirmedTransfer (called on confirmation). Cash — and any
    // method that created no pending reconciliation — settles immediately.
    if (p.settle && transferReconciliationId == null) {
      await executor
        .update(creditosSchema)
        .set({ status: 'paid' })
        .where(eq(creditosSchema.id, p.creditoId));
      paidCreditoIds.push(p.creditoId);
    }
  }

  return {
    applied: appliedTotal,
    remaining: round2(remaining),
    paidCreditoIds,
    cashMovementId,
    hitCaja: cashMovementId != null,
  };
}

// Settles the creditos covered by a transfer reconciliation once it is confirmed
// in caja. Until confirmation the abono is recorded but does NOT count toward the
// balance (see fetchEnrichedCreditos) nor mark the credito paid (see the settle
// gate in recordAbonoTx). Now that the money has landed, any covered credito that
// reaches a zero balance flips to 'paid'. Runs inside the confirmTransfer
// transaction; idempotent, so re-confirming only re-checks and never over-settles.
export async function settleCreditosForConfirmedTransfer(
  executor: Executor,
  args: { organizationId: string; reconciliationId: string },
): Promise<string[]> {
  const movements = await executor
    .select({ creditoId: creditoMovementsSchema.creditoId })
    .from(creditoMovementsSchema)
    .where(
      and(
        eq(creditoMovementsSchema.organizationId, args.organizationId),
        eq(
          creditoMovementsSchema.transferReconciliationId,
          args.reconciliationId,
        ),
        eq(creditoMovementsSchema.type, 'payment'),
      ),
    );
  const creditoIds = [...new Set(movements.map(m => m.creditoId))];
  if (creditoIds.length === 0) {
    return [];
  }

  const creditos = await executor
    .select({
      id: creditosSchema.id,
      originalAmount: creditosSchema.originalAmount,
    })
    .from(creditosSchema)
    .where(
      and(
        inArray(creditosSchema.id, creditoIds),
        eq(creditosSchema.status, 'pending'),
      ),
    );

  const settled: string[] = [];
  for (const c of creditos) {
    // Confirmed money only — same rule as fetchEnrichedCreditos. The
    // reconciliation we just confirmed now counts; any still-pending one does not.
    const [row] = await executor
      .select({
        paid: sql<string>`COALESCE(SUM(${creditoMovementsSchema.amount}) FILTER (WHERE ${creditoMovementsSchema.type} = 'payment' AND (${creditoMovementsSchema.transferReconciliationId} IS NULL OR ${transferReconciliationsSchema.status} = 'confirmed')), 0)::text`,
      })
      .from(creditoMovementsSchema)
      .leftJoin(
        transferReconciliationsSchema,
        eq(
          creditoMovementsSchema.transferReconciliationId,
          transferReconciliationsSchema.id,
        ),
      )
      .where(eq(creditoMovementsSchema.creditoId, c.id));
    const paid = Number.parseFloat(row?.paid ?? '0') || 0;
    const balance = round2((Number.parseFloat(c.originalAmount) || 0) - paid);
    if (balance <= 0) {
      await executor
        .update(creditosSchema)
        .set({ status: 'paid' })
        .where(eq(creditosSchema.id, c.id));
      settled.push(c.id);
    }
  }
  return settled;
}

// ── Write: extend the due date (audited) ─────────────────────────────────────

export type ExtendTermArgs = {
  organizationId: string;
  creditoId: string;
  newDueDate: string; // 'YYYY-MM-DD'
  reason?: string | null;
  createdBy: string;
};

export async function extendCreditoTerm(
  args: ExtendTermArgs,
): Promise<{ dueDateBefore: string; dueDateAfter: string }> {
  return db.transaction(tx => extendCreditoTermTx(tx, args));
}

// Transaction body, exported for integration tests.
export async function extendCreditoTermTx(
  executor: Executor,
  args: ExtendTermArgs,
): Promise<{ dueDateBefore: string; dueDateAfter: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.newDueDate)) {
    throw new Error('Fecha de vencimiento inválida');
  }

  const [credito] = await executor
    .select({ id: creditosSchema.id, dueDate: creditosSchema.dueDate })
    .from(creditosSchema)
    .where(
      and(
        eq(creditosSchema.id, args.creditoId),
        eq(creditosSchema.organizationId, args.organizationId),
        eq(creditosSchema.status, 'pending'),
      ),
    )
    .for('update')
    .limit(1);

  if (!credito) {
    throw new Error('Credito no encontrado o ya pagado');
  }

  const dueDateBefore = credito.dueDate;
  await executor
    .update(creditosSchema)
    .set({ dueDate: args.newDueDate })
    .where(eq(creditosSchema.id, credito.id));

  await executor.insert(creditoMovementsSchema).values({
    creditoId: credito.id,
    organizationId: args.organizationId,
    type: 'extension',
    amount: '0',
    dueDateBefore,
    dueDateAfter: args.newDueDate,
    note: args.reason ?? null,
    createdBy: args.createdBy,
  });

  return { dueDateBefore, dueDateAfter: args.newDueDate };
}

// ── Read: enriched rows + client grouping ────────────────────────────────────

type EnrichedCredito = {
  id: string;
  customerId: string | null;
  // Set when this credito is an employee loan (vale). Drives the `emp:<id>`
  // client key and the "Empleado" badge.
  employeeId: string | null;
  // Live pos_users.name for the employee (null for customer creditos).
  employeeName: string | null;
  saleId: string | null;
  notes: string | null;
  originalAmount: number;
  dueDate: string;
  status: 'pending' | 'paid' | 'written_off';
  createdAt: Date;
  paid: number;
  balance: number;
  // Money abonado via a transfer whose arrival the cashier hasn't confirmed in
  // caja yet. It does NOT count toward `paid`/`balance` until confirmed.
  pendingConfirmation: number;
  lastMovementAt: Date | null;
};

async function fetchEnrichedCreditos(
  organizationId: string,
  status?: 'pending' | 'paid',
): Promise<EnrichedCredito[]> {
  const conds = [eq(creditosSchema.organizationId, organizationId)];
  if (status) {
    conds.push(eq(creditosSchema.status, status));
  }

  const rows = await db
    .select({
      id: creditosSchema.id,
      customerId: creditosSchema.customerId,
      employeeId: creditosSchema.employeeId,
      // Live employee name (null for customer creditos). LEFT JOIN so customer
      // rows are unaffected — they simply carry a null employeeName.
      employeeName: posUsersSchema.name,
      saleId: creditosSchema.saleId,
      notes: creditosSchema.notes,
      originalAmount: creditosSchema.originalAmount,
      dueDate: creditosSchema.dueDate,
      status: creditosSchema.status,
      createdAt: creditosSchema.createdAt,
    })
    .from(creditosSchema)
    .leftJoin(posUsersSchema, eq(posUsersSchema.id, creditosSchema.employeeId))
    .where(and(...conds));

  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map(r => r.id);
  // `paid` counts only money that has actually landed: cash (no reconciliation)
  // or a CONFIRMED transfer. A transfer abono pending confirmation in caja is
  // money not yet arrived — it is tracked separately in `pendingConfirmation`
  // and must not reduce the balance nor settle the debt until confirmed.
  const agg = await db
    .select({
      creditoId: creditoMovementsSchema.creditoId,
      paid: sql<string>`COALESCE(SUM(${creditoMovementsSchema.amount}) FILTER (WHERE ${creditoMovementsSchema.type} = 'payment' AND (${creditoMovementsSchema.transferReconciliationId} IS NULL OR ${transferReconciliationsSchema.status} = 'confirmed')), 0)::text`,
      pendingConfirmation: sql<string>`COALESCE(SUM(${creditoMovementsSchema.amount}) FILTER (WHERE ${creditoMovementsSchema.type} = 'payment' AND ${creditoMovementsSchema.transferReconciliationId} IS NOT NULL AND ${transferReconciliationsSchema.status} = 'pending'), 0)::text`,
      last: sql<Date>`MAX(${creditoMovementsSchema.createdAt})`,
    })
    .from(creditoMovementsSchema)
    .leftJoin(
      transferReconciliationsSchema,
      eq(
        creditoMovementsSchema.transferReconciliationId,
        transferReconciliationsSchema.id,
      ),
    )
    .where(inArray(creditoMovementsSchema.creditoId, ids))
    .groupBy(creditoMovementsSchema.creditoId);
  const aggById = new Map(agg.map(a => [a.creditoId, a]));

  return rows.map((r) => {
    const a = aggById.get(r.id);
    const original = Number.parseFloat(r.originalAmount) || 0;
    const paid = a ? Number.parseFloat(a.paid) || 0 : 0;
    const pendingConfirmation = a
      ? Number.parseFloat(a.pendingConfirmation) || 0
      : 0;
    return {
      ...r,
      originalAmount: original,
      paid,
      balance: round2(Math.max(0, original - paid)),
      pendingConfirmation: round2(pendingConfirmation),
      lastMovementAt: a?.last ? new Date(a.last) : r.createdAt,
    };
  });
}

export type ClientDebt = {
  clientKey: string;
  name: string;
  phone: string;
  customerId: string | null;
  original: number;
  paid: number;
  balance: number;
  pct: number; // 0..100 paid
  dueDate: string; // earliest pending due date drives the headline state
  dueState: CreditoDueState;
  dueDays: number;
  lastMovementAt: string | null;
  creditoCount: number;
  creditoIds: string[];
  // Total abonado by transfer that is still awaiting caja confirmation.
  pendingConfirmation: number;
  // True when this group is an employee loan (vale) — the wall/POS badge it as
  // "Empleado". Customer debts are always false.
  isEmployee: boolean;
};

function groupByClient(
  creditos: EnrichedCredito[],
  today: Date = new Date(),
): ClientDebt[] {
  const groups = new Map<string, EnrichedCredito[]>();
  for (const f of creditos) {
    const key = clientKeyOf(f);
    const list = groups.get(key);
    if (list) {
      list.push(f);
    } else {
      groups.set(key, [f]);
    }
  }

  const result: ClientDebt[] = [];
  for (const [clientKey, list] of groups) {
    const original = round2(list.reduce((a, f) => a + f.originalAmount, 0));
    const paid = round2(list.reduce((a, f) => a + f.paid, 0));
    const balance = round2(list.reduce((a, f) => a + f.balance, 0));
    const pendingConfirmation = round2(
      list.reduce((a, f) => a + f.pendingConfirmation, 0),
    );
    // Employee loans carry no "Cliente: … | Tel: …" notes; their display name is
    // the live pos_users.name (snapshotted in notes as a fallback). Customer
    // groups keep the exact notes-parsed identity — unchanged.
    const isEmployee = list[0]?.employeeId != null;
    const parsed = parseClient(list[0]?.notes ?? null);
    const name = isEmployee
      ? list[0]?.employeeName ?? list[0]?.notes ?? ''
      : parsed.name;
    const phone = isEmployee ? '' : parsed.phone;
    const allPaid = list.every(f => f.status !== 'pending');
    // Headline due date = the most urgent (earliest) still-pending due date.
    const pendingDues = list
      .filter(f => f.status === 'pending')
      .map(f => f.dueDate)
      .sort();
    const dueDate = pendingDues[0] ?? list[0]?.dueDate ?? '';
    const { state, days } = deriveDueState(dueDate, allPaid, today);
    const lastMovementAt = list
      .map(f => f.lastMovementAt)
      .filter((d): d is Date => d != null)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    result.push({
      clientKey,
      name: name || 'Sin nombre',
      phone,
      customerId: list[0]?.customerId ?? null,
      original,
      paid,
      balance,
      pct: original > 0 ? Math.min(100, Math.round((paid / original) * 100)) : 0,
      dueDate,
      dueState: state,
      dueDays: days,
      lastMovementAt: lastMovementAt ? lastMovementAt.toISOString() : null,
      creditoCount: list.length,
      creditoIds: list.map(f => f.id),
      pendingConfirmation,
      isEmployee,
    });
  }

  return result;
}

export type CreditosMetrics = {
  pendingTotal: number;
  clientsWithDebt: number;
  overdue: number;
  dueSoon: number;
  recoveredThisMonth: number;
};

export type CreditosOverview = {
  metrics: CreditosMetrics;
  clients: ClientDebt[];
};

// Pendientes tab + dashboard metrics. Clients sorted most-urgent first.
export async function getCreditosOverview(
  organizationId: string,
): Promise<CreditosOverview> {
  const today = new Date();
  const pending = await fetchEnrichedCreditos(organizationId, 'pending');
  const clients = groupByClient(pending, today).sort(
    (a, b) => a.dueDays - b.dueDays,
  );

  // Recovered = money that actually landed this month: cash plus CONFIRMED
  // transfers. A transfer abono still awaiting caja confirmation is NOT counted,
  // so the metric never reports money that hasn't arrived.
  const [recovered] = await db
    .select({
      sum: sql<string>`COALESCE(SUM(${creditoMovementsSchema.amount}) FILTER (WHERE ${creditoMovementsSchema.type} = 'payment' AND (${creditoMovementsSchema.transferReconciliationId} IS NULL OR ${transferReconciliationsSchema.status} = 'confirmed')), 0)::text`,
    })
    .from(creditoMovementsSchema)
    .leftJoin(
      transferReconciliationsSchema,
      eq(
        creditoMovementsSchema.transferReconciliationId,
        transferReconciliationsSchema.id,
      ),
    )
    .where(
      and(
        eq(creditoMovementsSchema.organizationId, organizationId),
        sql`${creditoMovementsSchema.createdAt} >= date_trunc('month', now() AT TIME ZONE 'America/Bogota')`,
      ),
    );

  return {
    metrics: {
      pendingTotal: round2(clients.reduce((a, c) => a + c.balance, 0)),
      clientsWithDebt: clients.length,
      overdue: clients.filter(c => c.dueState === 'overdue').length,
      dueSoon: clients.filter(c => c.dueState === 'due_soon').length,
      recoveredThisMonth: Number.parseFloat(recovered?.sum ?? '0') || 0,
    },
    clients,
  };
}

// Historial tab: clients whose creditos are fully paid. Persisted forever.
export async function getCreditosHistory(
  organizationId: string,
): Promise<ClientDebt[]> {
  const paid = await fetchEnrichedCreditos(organizationId, 'paid');
  return groupByClient(paid).sort((a, b) => {
    const at = a.lastMovementAt ? Date.parse(a.lastMovementAt) : 0;
    const bt = b.lastMovementAt ? Date.parse(b.lastMovementAt) : 0;
    return bt - at;
  });
}

// Same settled-credito data as getCreditosHistory, mapped to the snake_case wire
// shape the cashier device (pos-merchatai CreditosCajero history tab) reads. The
// history is org-wide on purpose: a debt settled at ANY register/sede of the org
// shows here, not only the ones the current cashier closed.
export type PosCreditoHistoryItem = {
  id: string; // clientKey — unique per client, used as the list key
  client_name: string;
  client_phone: string | null;
  total: number; // full amount of the debt that was settled
  created_at: string; // when the oldest credito in the group was generated
  settled_at: string; // when the last payment landed
};

export async function getCreditosHistoryForPos(
  organizationId: string,
): Promise<PosCreditoHistoryItem[]> {
  const paid = await fetchEnrichedCreditos(organizationId, 'paid');

  const groups = new Map<string, EnrichedCredito[]>();
  for (const f of paid) {
    const key = clientKeyOf(f);
    const list = groups.get(key);
    if (list) {
      list.push(f);
    } else {
      groups.set(key, [f]);
    }
  }

  const items: PosCreditoHistoryItem[] = [];
  for (const [clientKey, list] of groups) {
    const isEmployee = list[0]?.employeeId != null;
    const parsed = parseClient(list[0]?.notes ?? null);
    const name = isEmployee
      ? list[0]?.employeeName ?? list[0]?.notes ?? ''
      : parsed.name;
    const phone = isEmployee ? '' : parsed.phone;
    const total = round2(list.reduce((a, f) => a + f.originalAmount, 0));
    const createdAt = list
      .map(f => f.createdAt)
      .reduce((a, b) => (a < b ? a : b));
    const settledAt = list
      .map(f => f.lastMovementAt ?? f.createdAt)
      .reduce((a, b) => (a > b ? a : b));
    items.push({
      id: clientKey,
      client_name: name || 'Sin nombre',
      client_phone: phone || null,
      total,
      created_at: createdAt.toISOString(),
      settled_at: settledAt.toISOString(),
    });
  }

  return items.sort(
    (a, b) => Date.parse(b.settled_at) - Date.parse(a.settled_at),
  );
}

// ── POS (cashier app) compatibility ──────────────────────────────────────────
// The cashier endpoints (/api/pos/creditos*) read from the SAME ledger as the
// dashboard so an abono on either surface stays consistent. These map the
// ledger onto the legacy JSON shape the cashier UI already expects.

export type PosCreditoSale = {
  id: string;
  total: number;
  paid: number;
  pending: number;
  createdAt: string;
  daysOld: number;
};

// Wire shape consumed by the cashier device (pos-merchatai CreditosCajero). Kept
// in snake_case on purpose — the device reads these exact keys. `id` IS the
// clientKey: the device passes it straight back to /pos/creditos/abonar and
// /pos/creditos/settle as `clientKey`.
export type PosCreditoClient = {
  id: string;
  client_name: string;
  client_phone: string | null;
  total_owed: number;
  days_overdue: number;
  risk_level: 'high' | 'mid' | 'low';
  status: 'pending' | 'partial' | 'settled';
  last_activity: string;
  notes: string | null;
  // True when this debtor is an employee (vale / préstamo). Additive: the POS
  // reads it to badge the row "Empleado"; older clients ignore it.
  is_employee: boolean;
  // Monto abonado por TRANSFERENCIA que aún no se confirma (transfer_reconciliation
  // pending). > 0 ⇒ el POS muestra "pendiente a confirmar" en la tarjeta. Additive.
  pending_confirmation: number;
  sales: PosCreditoSale[];
};

export type PosCreditosResult = {
  stats: {
    total_owed: number;
    urgent: number;
    remind: number;
    ok: number;
    total_clients: number;
  };
  clients: PosCreditoClient[];
};

function riskFromDueState(state: CreditoDueState): 'high' | 'mid' | 'low' {
  if (state === 'overdue') {
    return 'high';
  }
  if (state === 'due_soon') {
    return 'mid';
  }
  return 'low';
}

export async function getCreditosForPos(
  organizationId: string,
): Promise<PosCreditosResult> {
  const pending = await fetchEnrichedCreditos(organizationId, 'pending');
  const today = new Date();

  const groups = new Map<string, EnrichedCredito[]>();
  for (const f of pending) {
    const key = clientKeyOf(f);
    const list = groups.get(key);
    if (list) {
      list.push(f);
    } else {
      groups.set(key, [f]);
    }
  }

  const ageDays = (d: Date) =>
    Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86_400_000));

  const clients: PosCreditoClient[] = [];
  for (const [clientKey, list] of groups) {
    const isEmployee = list[0]?.employeeId != null;
    const parsed = parseClient(list[0]?.notes ?? null);
    const name = isEmployee
      ? list[0]?.employeeName ?? list[0]?.notes ?? ''
      : parsed.name;
    const phone = isEmployee ? '' : parsed.phone;
    const dueDate = list.map(f => f.dueDate).sort()[0] ?? '';
    const { state } = deriveDueState(dueDate, false, today);
    clients.push({
      id: clientKey,
      client_name: name || 'Sin nombre',
      client_phone: phone || null,
      total_owed: round2(list.reduce((a, f) => a + f.balance, 0)),
      days_overdue: list.reduce((a, f) => Math.max(a, ageDays(f.createdAt)), 0),
      risk_level: riskFromDueState(state),
      status: 'pending',
      last_activity:
        list.map(f => f.createdAt.toISOString()).sort().at(-1) ?? '',
      notes: null,
      is_employee: isEmployee,
      pending_confirmation: round2(
        list.reduce((a, f) => a + f.pendingConfirmation, 0),
      ),
      sales: list.map(f => ({
        id: f.saleId ?? f.id,
        total: f.originalAmount,
        paid: f.paid,
        pending: f.balance,
        createdAt: f.createdAt.toISOString(),
        daysOld: ageDays(f.createdAt),
      })),
    });
  }
  clients.sort((a, b) => b.days_overdue - a.days_overdue);

  return {
    stats: {
      total_owed: round2(clients.reduce((a, c) => a + c.total_owed, 0)),
      urgent: clients.filter(c => c.risk_level === 'high').length,
      remind: clients.filter(c => c.risk_level === 'mid').length,
      ok: clients.filter(c => c.risk_level === 'low').length,
      total_clients: clients.length,
    },
    clients,
  };
}

// Maps paid credito ids back to their origin sale ids, for the legacy
// `settledSaleIds` field in the cashier abono response.
export async function saleIdsForCreditos(
  organizationId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) {
    return [];
  }
  const rows = await db
    .select({ saleId: creditosSchema.saleId })
    .from(creditosSchema)
    .where(
      and(
        eq(creditosSchema.organizationId, organizationId),
        inArray(creditosSchema.id, ids),
      ),
    );
  return rows.map(r => r.saleId).filter((x): x is string => x != null);
}

// Pending balance for a client, used by the cashier "marcar como pagado" path.
export async function getClientPendingBalance(
  organizationId: string,
  clientKey: string,
): Promise<number> {
  const pending = await fetchEnrichedCreditos(organizationId, 'pending');
  return round2(
    pending
      .filter(f => clientKeyOf(f) === clientKey)
      .reduce((a, f) => a + f.balance, 0),
  );
}

// ── Read: single client detail + timeline ────────────────────────────────────

export type CreditoTimelineEntry = {
  id: string;
  creditoId: string;
  type: 'charge' | 'payment' | 'extension' | 'writeoff' | 'adjustment';
  amount: number;
  method: string | null;
  dueDateBefore: string | null;
  dueDateAfter: string | null;
  note: string | null;
  createdBy: string | null;
  // Cash abono that landed in the drawer (created a cash_movements row).
  hitCaja: boolean;
  // A transfer/digital abono routes to the caja confirmation queue
  // (transfer_reconciliations). pendingConfirmation = created, cashier hasn't
  // verified the money arrived yet; confirmedInCaja = matched to a bank deposit.
  pendingConfirmation: boolean;
  confirmedInCaja: boolean;
  createdAt: string;
};

export type ClientDetail = {
  client: ClientDebt;
  creditos: {
    id: string;
    saleId: string | null;
    original: number;
    paid: number;
    balance: number;
    dueDate: string;
    status: 'pending' | 'paid' | 'written_off';
    dueState: CreditoDueState;
    dueDays: number;
    createdAt: string;
  }[];
  timeline: CreditoTimelineEntry[];
};

export async function getClientDetail(
  organizationId: string,
  clientKey: string,
): Promise<ClientDetail | null> {
  const all = await fetchEnrichedCreditos(organizationId);
  const mine = all.filter(f => clientKeyOf(f) === clientKey);
  if (mine.length === 0) {
    return null;
  }

  const today = new Date();
  const [client] = groupByClient(mine, today);
  if (!client) {
    return null;
  }

  const creditos = mine
    .map((f) => {
      const { state, days } = deriveDueState(
        f.dueDate,
        f.status !== 'pending',
        today,
      );
      return {
        id: f.id,
        saleId: f.saleId,
        original: f.originalAmount,
        paid: f.paid,
        balance: f.balance,
        dueDate: f.dueDate,
        status: f.status,
        dueState: state,
        dueDays: days,
        createdAt: f.createdAt.toISOString(),
      };
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const ids = mine.map(f => f.id);
  // Left-join the reconciliation so a transfer abono can show its caja state
  // (pending → confirmed), mirroring how a cash abono shows "En caja".
  const movements = await db
    .select({
      id: creditoMovementsSchema.id,
      creditoId: creditoMovementsSchema.creditoId,
      type: creditoMovementsSchema.type,
      amount: creditoMovementsSchema.amount,
      method: creditoMovementsSchema.method,
      cashMovementId: creditoMovementsSchema.cashMovementId,
      transferReconciliationId: creditoMovementsSchema.transferReconciliationId,
      reconciliationStatus: transferReconciliationsSchema.status,
      dueDateBefore: creditoMovementsSchema.dueDateBefore,
      dueDateAfter: creditoMovementsSchema.dueDateAfter,
      note: creditoMovementsSchema.note,
      createdBy: creditoMovementsSchema.createdBy,
      createdAt: creditoMovementsSchema.createdAt,
    })
    .from(creditoMovementsSchema)
    .leftJoin(
      transferReconciliationsSchema,
      eq(
        creditoMovementsSchema.transferReconciliationId,
        transferReconciliationsSchema.id,
      ),
    )
    .where(inArray(creditoMovementsSchema.creditoId, ids))
    .orderBy(asc(creditoMovementsSchema.createdAt));

  const timeline: CreditoTimelineEntry[] = movements.map(m => ({
    id: m.id,
    creditoId: m.creditoId,
    type: m.type,
    amount: Number.parseFloat(m.amount) || 0,
    method: m.method,
    dueDateBefore: m.dueDateBefore,
    dueDateAfter: m.dueDateAfter,
    note: m.note,
    createdBy: m.createdBy,
    hitCaja: m.cashMovementId != null,
    pendingConfirmation:
      m.transferReconciliationId != null && m.reconciliationStatus === 'pending',
    confirmedInCaja:
      m.transferReconciliationId != null
      && m.reconciliationStatus === 'confirmed',
    createdAt: m.createdAt.toISOString(),
  }));

  return { client, creditos, timeline };
}

// ── Read: a customer's credit, resolved by IDENTITY (not just the FK) ─────────
//
// The customer ficha needs THIS customer's outstanding credit + abonos. It must
// NOT look creditos up by `c:<id>` alone: most POS creditos are created with
// customer_id = NULL and group under `n:<base64(name||phone)>` (parsed from the
// notes), so a FK-only lookup finds nothing and the ficha shows 0 even though the
// créditos wall shows the debt. Instead we reuse the wall's OWN grouping
// (groupByClient) and claim every group that belongs to this customer by any of:
//   • the real FK (group.customerId === customer.id),
//   • matching whatsapp (normalizeWhatsapp on BOTH sides, so formatting differs
//     harmlessly), or
//   • a case-insensitive, trimmed name match (last resort; never matches the
//     "Sin nombre" placeholder).
// Then it sums their balances and merges their abonos — so the ficha shows exactly
// what the wall shows. Null-safe: a customer with no whatsapp and no matching
// group yields balance 0 and no abonos.
export type CustomerCreditSummary = {
  balance: number;
  abonos: {
    id: string;
    amount: number;
    method: string | null;
    createdAt: string;
  }[];
  // Ventas (fiado) ligadas a este cliente POR IDENTIDAD (FK/whatsapp/nombre),
  // aunque la venta tenga customer_id NULL. La ficha las usa para listar las
  // compras del cliente, no solo los abonos.
  saleIds: string[];
};

export async function getCustomerCreditSummary(
  organizationId: string,
  customer: { id: string; name: string | null; whatsapp: string | null },
): Promise<CustomerCreditSummary> {
  const all = await fetchEnrichedCreditos(organizationId);
  if (all.length === 0) {
    return { balance: 0, abonos: [], saleIds: [] };
  }

  const groups = groupByClient(all);
  const wantWa = normalizeWhatsapp(customer.whatsapp);
  const wantName = customer.name?.trim().toLowerCase() ?? '';

  const mine = groups.filter((g) => {
    // An employee loan is never a customer's debt — keep it off the ficha even
    // if an employee happens to share a name with this customer.
    if (g.isEmployee) {
      return false;
    }
    if (g.customerId && g.customerId === customer.id) {
      return true;
    }
    if (wantWa && normalizeWhatsapp(g.phone) === wantWa) {
      return true;
    }
    const gName = g.name.trim().toLowerCase();
    if (wantName && gName === wantName && gName !== 'sin nombre') {
      return true;
    }
    return false;
  });

  if (mine.length === 0) {
    return { balance: 0, abonos: [], saleIds: [] };
  }

  const balance = round2(mine.reduce((a, g) => a + g.balance, 0));
  const creditoIds = mine.flatMap(g => g.creditoIds);
  if (creditoIds.length === 0) {
    return { balance, abonos: [], saleIds: [] };
  }

  // Ventas (fiado) de este cliente por identidad — aunque tengan customer_id NULL.
  const saleRows = await db
    .select({ saleId: creditosSchema.saleId })
    .from(creditosSchema)
    .where(inArray(creditosSchema.id, creditoIds));
  const saleIds = [
    ...new Set(
      saleRows.map(r => r.saleId).filter((x): x is string => !!x),
    ),
  ];

  const movements = await db
    .select({
      id: creditoMovementsSchema.id,
      amount: creditoMovementsSchema.amount,
      method: creditoMovementsSchema.method,
      createdAt: creditoMovementsSchema.createdAt,
    })
    .from(creditoMovementsSchema)
    .where(
      and(
        inArray(creditoMovementsSchema.creditoId, creditoIds),
        eq(creditoMovementsSchema.type, 'payment'),
      ),
    )
    .orderBy(desc(creditoMovementsSchema.createdAt));

  return {
    balance,
    abonos: movements.map(m => ({
      id: m.id,
      amount: Number.parseFloat(m.amount) || 0,
      method: m.method,
      createdAt: m.createdAt.toISOString(),
    })),
    saleIds,
  };
}

// ── Employee loans (vale / préstamo) — caja repayment + outstanding list ──────
//
// Employee loans are creditos with employeeId set. These two functions preserve
// the exact wire contract the POS already speaks (POST /pos/cash/movement with
// loanSelections, and GET /pos/employee-loans) after the unification — `loanId`
// is now simply a credito id. The balance is COMPUTED from the credito_movements
// ledger (charge − payments), never denormalized, matching the customer path.

// Sum of settled `payment` movements per credito. Cash and every non-transfer
// abono land immediately; a transfer counts only once confirmed — mirrors the
// customer aggregate in fetchEnrichedCreditos so a loan can be paid by either
// path without double-counting.
async function paidByCreditoIds(
  executor: Executor,
  creditoIds: string[],
): Promise<Map<string, number>> {
  if (creditoIds.length === 0) {
    return new Map();
  }
  const rows = await executor
    .select({
      creditoId: creditoMovementsSchema.creditoId,
      paid: sql<string>`COALESCE(SUM(${creditoMovementsSchema.amount}) FILTER (WHERE ${creditoMovementsSchema.type} = 'payment' AND (${creditoMovementsSchema.transferReconciliationId} IS NULL OR ${transferReconciliationsSchema.status} = 'confirmed')), 0)::text`,
    })
    .from(creditoMovementsSchema)
    .leftJoin(
      transferReconciliationsSchema,
      eq(
        creditoMovementsSchema.transferReconciliationId,
        transferReconciliationsSchema.id,
      ),
    )
    .where(inArray(creditoMovementsSchema.creditoId, creditoIds))
    .groupBy(creditoMovementsSchema.creditoId);
  return new Map(rows.map(r => [r.creditoId, Number.parseFloat(r.paid) || 0]));
}

export type EmployeeLoanRepaymentSelection = { loanId: string; amount: number };

export type EmployeeLoanRepaymentInput = {
  organizationId: string;
  sessionId: string;
  createdBy: string;
  selections: EmployeeLoanRepaymentSelection[];
};

export type EmployeeLoanRepaymentResult = {
  appliedTotal: number;
  // Credito ids that reached a zero balance (status → paid) in this call.
  settledLoans: string[];
};

// Applies caller-chosen caja abonos to employee-loan creditos inside the caller's
// tx. For each selection: locks the credito (org-scoped, must be an employee
// loan, must not already be paid), inserts a `credito_payment` cash_movements
// INFLOW (cash back into the drawer) + a `payment` credito_movements ledger row
// (method 'efectivo'), then flips the credito to 'paid' when the ledger balance
// hits zero. `loanId` is a credito id.
export async function recordEmployeeLoanRepaymentCaja(
  executor: Executor,
  input: EmployeeLoanRepaymentInput,
): Promise<EmployeeLoanRepaymentResult> {
  if (input.selections.length === 0) {
    throw new Error('No seleccionaste ningún préstamo');
  }

  const ids = input.selections.map(s => s.loanId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Hay préstamos repetidos en la selección');
  }

  // Deterministic id-sorted order → consistent lock acquisition, no deadlock.
  const ordered = [...input.selections].sort((a, b) =>
    a.loanId.localeCompare(b.loanId),
  );

  let appliedTotal = 0;
  const settledLoans: string[] = [];

  for (const sel of ordered) {
    const amount = round2(sel.amount);
    if (!(amount > 0)) {
      throw new Error('El monto de cada abono debe ser mayor a 0');
    }

    // 1. Lock the credito FOR UPDATE (org-scoped). Must be an employee loan.
    const [loan] = await executor
      .select({
        id: creditosSchema.id,
        employeeId: creditosSchema.employeeId,
        originalAmount: creditosSchema.originalAmount,
        status: creditosSchema.status,
      })
      .from(creditosSchema)
      .where(
        and(
          eq(creditosSchema.id, sel.loanId),
          eq(creditosSchema.organizationId, input.organizationId),
        ),
      )
      .for('update')
      .limit(1);

    if (!loan || loan.employeeId == null) {
      throw new Error(
        'El préstamo seleccionado no existe o no pertenece a esta organización',
      );
    }
    if (loan.status === 'paid') {
      throw new Error('Ese préstamo ya está saldado — no acepta más abonos');
    }

    const total = round2(Number.parseFloat(loan.originalAmount) || 0);
    const paidMap = await paidByCreditoIds(executor, [loan.id]);
    const alreadyPaid = round2(paidMap.get(loan.id) ?? 0);
    const outstanding = round2(total - alreadyPaid);

    if (amount > outstanding + 0.005) {
      throw new Error(
        `El abono ($${amount.toFixed(2)}) supera el saldo del préstamo ($${outstanding.toFixed(2)})`,
      );
    }

    // 2. Insert the credito_payment cash_movements row — cash INTO the drawer.
    const [movRow] = await executor
      .insert(cashMovementsSchema)
      .values({
        sessionId: input.sessionId,
        organizationId: input.organizationId,
        type: 'credito_payment',
        amount: toMoney(amount),
        reason: 'Abono de préstamo de empleado',
        createdBy: input.createdBy,
      })
      .returning({ id: cashMovementsSchema.id });

    if (!movRow) {
      throw new Error(
        'recordEmployeeLoanRepaymentCaja: no se pudo registrar el movimiento de caja',
      );
    }

    // 3. Insert the payment credito_movements ledger row (efectivo).
    await executor.insert(creditoMovementsSchema).values({
      creditoId: loan.id,
      organizationId: input.organizationId,
      type: 'payment',
      amount: toMoney(amount),
      method: 'efectivo',
      cashMovementId: movRow.id,
      createdBy: input.createdBy,
    });

    // 4. Recompute status from the ledger balance.
    const newBalance = round2(total - round2(alreadyPaid + amount));
    if (newBalance <= 0.005) {
      await executor
        .update(creditosSchema)
        .set({ status: 'paid' })
        .where(eq(creditosSchema.id, loan.id));
      settledLoans.push(loan.id);
    }

    appliedTotal = round2(appliedTotal + amount);
  }

  return { appliedTotal, settledLoans };
}

// Outstanding employee loans for the org, oldest-first, with the employee's live
// name resolved (falling back to the notes snapshot). Read-only. Balance is
// computed from the ledger. Preserves the GET /pos/employee-loans response shape.
export type OutstandingEmployeeLoan = {
  loanId: string;
  employeeId: string;
  employeeName: string | null;
  totalAmount: number;
  outstanding: number;
  createdAt: Date;
  notes: string | null;
};

export async function listOutstandingEmployeeLoans(
  executor: Executor,
  organizationId: string,
): Promise<OutstandingEmployeeLoan[]> {
  const rows = await executor
    .select({
      loanId: creditosSchema.id,
      employeeId: creditosSchema.employeeId,
      userName: posUsersSchema.name,
      totalAmount: creditosSchema.originalAmount,
      createdAt: creditosSchema.createdAt,
      notes: creditosSchema.notes,
    })
    .from(creditosSchema)
    .leftJoin(posUsersSchema, eq(posUsersSchema.id, creditosSchema.employeeId))
    .where(
      and(
        eq(creditosSchema.organizationId, organizationId),
        eq(creditosSchema.status, 'pending'),
        sql`${creditosSchema.employeeId} IS NOT NULL`,
      ),
    )
    .orderBy(asc(creditosSchema.createdAt));

  if (rows.length === 0) {
    return [];
  }

  const paidMap = await paidByCreditoIds(
    executor,
    rows.map(r => r.loanId),
  );

  return rows.map((r) => {
    const total = round2(Number.parseFloat(r.totalAmount) || 0);
    const outstanding = round2(total - (paidMap.get(r.loanId) ?? 0));
    return {
      loanId: r.loanId,
      // employeeId IS NOT NULL is guaranteed by the WHERE above.
      employeeId: r.employeeId as string,
      employeeName: r.userName ?? r.notes ?? null,
      totalAmount: total,
      outstanding,
      createdAt: r.createdAt,
      notes: r.notes,
    };
  });
}
