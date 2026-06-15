import type { FiadoDueState } from '@/libs/fiados-shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { findOpenSession } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import {
  clientKeyOf,
  normalizeClientKey,
  parseClient,
  planAbono,
  round2,
} from '@/libs/fiados-math';
import {
  addDaysISO,
  deriveDueState,
} from '@/libs/fiados-shared';
import {
  createFiadoTransferReconciliation,
  methodNeedsReconciliation,
} from '@/libs/transfer-reconciliation';
import {
  appSettingsSchema,
  cashMovementsSchema,
  cashSessionsSchema,
  fiadoMovementsSchema,
  fiadosSchema,
} from '@/models/Schema';

export {
  addDaysISO,
  daysUntilDue,
  deriveDueState,
  DUE_SOON_DAYS,
  FIADO_PAYMENT_METHODS,
  type FiadoDueState,
} from '@/libs/fiados-shared';
// Re-exported so the POS endpoints and the dashboard share one identity logic.
export { clientKeyOf, normalizeClientKey, parseClient };

// Core fiados (store-credit / accounts-receivable) service. Single source of
// truth for the money + ledger logic, kept out of the 'use server' action layer
// so it can run INSIDE a sale transaction (executor-aware) and be unit-reasoned
// without Clerk. The actions in actions/fiados.ts are thin auth+revalidate wrappers.
//
// Model (see models/Schema.ts): one `fiados` row per credit sale; an append-only
// `fiado_movements` ledger (charge/payment/extension/writeoff/adjustment) that is
// the timeline, the Caja link and the audit trail. The UI groups fiados BY CLIENT
// because that is how a tendero thinks ("¿quién me debe?").

// Exported for integration tests (pglite executor).
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_TERM_DAYS = 30;
export const TERM_SETTING_KEY = 'fiados-default-term-days';

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

// ── Write: create a fiado from a sale ────────────────────────────────────────

export type CreateFiadoArgs = {
  organizationId: string;
  saleId: string;
  originalAmount: number | string;
  // 'YYYY-MM-DD'. When omitted, computed from the org default term.
  dueDate?: string | null;
  customerId?: string | null;
  createdBy?: string | null;
  // The "Cliente: NAME | Tel: PHONE" display string (usually the sale notes).
  notes?: string | null;
  // Align the charge movement (and the fiado) with the original sale time, for
  // the offline POS sync path that replays older sales.
  createdAt?: Date;
};

// Inserts the fiado account + its opening `charge` movement. Runs inside the
// sale transaction (pass the tx as executor). Returns null for a zero amount.
export async function createFiado(
  executor: Executor,
  args: CreateFiadoArgs,
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

  const [fiado] = await executor
    .insert(fiadosSchema)
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
    // spawns a second fiado.
    .onConflictDoNothing()
    .returning({ id: fiadosSchema.id });

  if (!fiado) {
    return null;
  }

  await executor.insert(fiadoMovementsSchema).values({
    fiadoId: fiado.id,
    organizationId: args.organizationId,
    type: 'charge',
    amount,
    note: 'Venta fiada',
    createdBy: args.createdBy ?? null,
    ...(args.createdAt ? { createdAt: args.createdAt } : {}),
  });

  return fiado;
}

// ── Write: register an abono (payment) for a client ──────────────────────────

export type RecordAbonoArgs = {
  organizationId: string;
  // Groups the client's fiados (see clientKeyOf).
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
  paidFiadoIds: string[];
  cashMovementId: string | null;
  // True when the cash hit the drawer; false for digital, or cash with no open
  // Caja session (the abono is still recorded, the drawer just can't reflect it).
  hitCaja: boolean;
};

// Applies an abono FIFO across the client's pending fiados (oldest due first).
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
  if (/fiado/i.test(method)) {
    throw new Error('El abono no puede ser de tipo fiado');
  }

  // Scan the org's pending fiados (no lock) to find the client's IDs,
  // oldest-due-first. Then lock only those rows — avoids serializing
  // unrelated clients' abonos in the same org.
  const candidates = await executor
    .select({
      id: fiadosSchema.id,
      customerId: fiadosSchema.customerId,
      notes: fiadosSchema.notes,
      originalAmount: fiadosSchema.originalAmount,
    })
    .from(fiadosSchema)
    .where(
      and(
        eq(fiadosSchema.organizationId, args.organizationId),
        eq(fiadosSchema.status, 'pending'),
      ),
    )
    .orderBy(asc(fiadosSchema.dueDate), asc(fiadosSchema.createdAt));

  const clientIds = candidates
    .filter(f => clientKeyOf(f) === args.clientKey)
    .map(f => f.id);
  if (clientIds.length === 0) {
    throw new Error('No se encontraron fiados pendientes para este cliente');
  }

  // Lock only the client's rows — not the whole org.
  const client = await executor
    .select({
      id: fiadosSchema.id,
      customerId: fiadosSchema.customerId,
      notes: fiadosSchema.notes,
      originalAmount: fiadosSchema.originalAmount,
    })
    .from(fiadosSchema)
    .where(inArray(fiadosSchema.id, clientIds))
    .orderBy(asc(fiadosSchema.dueDate), asc(fiadosSchema.createdAt))
    .for('update');

  const ids = client.map(f => f.id);
  const paidRows = await executor
    .select({
      fiadoId: fiadoMovementsSchema.fiadoId,
      paid: sql<string>`COALESCE(SUM(${fiadoMovementsSchema.amount}), 0)::text`,
    })
    .from(fiadoMovementsSchema)
    .where(
      and(
        inArray(fiadoMovementsSchema.fiadoId, ids),
        eq(fiadoMovementsSchema.type, 'payment'),
      ),
    )
    .groupBy(fiadoMovementsSchema.fiadoId);
  const paidById = new Map(
    paidRows.map(r => [r.fiadoId, Number.parseFloat(r.paid) || 0]),
  );

  const displayName = parseClient(client[0]?.notes ?? null).name || 'cliente';

  // Plan the FIFO distribution before writing anything. The math is pure and
  // unit-tested in fiados-math; here we only feed it balances and apply it.
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
          notes: 'Auto-abierta por cobro de fiado (no había caja abierta)',
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
          type: 'fiado_payment',
          amount: toMoney(appliedTotal),
          reason: `Cobro de fiado ${displayName}`.trim(),
          createdBy: args.createdBy,
        })
        .returning({ id: cashMovementsSchema.id });
      cashMovementId = cm?.id ?? null;
    }
  }

  // Digital abono (nequi/daviplata/transferencia): never touches the drawer, so
  // it gets ONE reconciliation row for the whole transfer (linked to every
  // fiado_movement it covers), mirroring how the cash portion gets one
  // cash_movement. The owner confirms it against the account later.
  let transferReconciliationId: string | null = null;
  if (
    !isCashMethod(method)
    && appliedTotal > 0
    && methodNeedsReconciliation(method)
  ) {
    const session = await findOpenSession(executor, args.organizationId);
    transferReconciliationId = await createFiadoTransferReconciliation(
      executor,
      {
        organizationId: args.organizationId,
        method,
        expectedAmount: appliedTotal,
        cashSessionId: session?.id ?? null,
      },
    );
  }

  const paidFiadoIds: string[] = [];
  for (const p of plan) {
    if (p.apply > 0) {
      await executor.insert(fiadoMovementsSchema).values({
        fiadoId: p.fiadoId,
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
    if (p.settle) {
      await executor
        .update(fiadosSchema)
        .set({ status: 'paid' })
        .where(eq(fiadosSchema.id, p.fiadoId));
      paidFiadoIds.push(p.fiadoId);
    }
  }

  return {
    applied: appliedTotal,
    remaining: round2(remaining),
    paidFiadoIds,
    cashMovementId,
    hitCaja: cashMovementId != null,
  };
}

// ── Write: extend the due date (audited) ─────────────────────────────────────

export type ExtendTermArgs = {
  organizationId: string;
  fiadoId: string;
  newDueDate: string; // 'YYYY-MM-DD'
  reason?: string | null;
  createdBy: string;
};

export async function extendFiadoTerm(
  args: ExtendTermArgs,
): Promise<{ dueDateBefore: string; dueDateAfter: string }> {
  return db.transaction(tx => extendFiadoTermTx(tx, args));
}

// Transaction body, exported for integration tests.
export async function extendFiadoTermTx(
  executor: Executor,
  args: ExtendTermArgs,
): Promise<{ dueDateBefore: string; dueDateAfter: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.newDueDate)) {
    throw new Error('Fecha de vencimiento inválida');
  }

  const [fiado] = await executor
    .select({ id: fiadosSchema.id, dueDate: fiadosSchema.dueDate })
    .from(fiadosSchema)
    .where(
      and(
        eq(fiadosSchema.id, args.fiadoId),
        eq(fiadosSchema.organizationId, args.organizationId),
        eq(fiadosSchema.status, 'pending'),
      ),
    )
    .for('update')
    .limit(1);

  if (!fiado) {
    throw new Error('Fiado no encontrado o ya pagado');
  }

  const dueDateBefore = fiado.dueDate;
  await executor
    .update(fiadosSchema)
    .set({ dueDate: args.newDueDate })
    .where(eq(fiadosSchema.id, fiado.id));

  await executor.insert(fiadoMovementsSchema).values({
    fiadoId: fiado.id,
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

type EnrichedFiado = {
  id: string;
  customerId: string | null;
  saleId: string | null;
  notes: string | null;
  originalAmount: number;
  dueDate: string;
  status: 'pending' | 'paid' | 'written_off';
  createdAt: Date;
  paid: number;
  balance: number;
  lastMovementAt: Date | null;
};

async function fetchEnrichedFiados(
  organizationId: string,
  status?: 'pending' | 'paid',
): Promise<EnrichedFiado[]> {
  const conds = [eq(fiadosSchema.organizationId, organizationId)];
  if (status) {
    conds.push(eq(fiadosSchema.status, status));
  }

  const rows = await db
    .select({
      id: fiadosSchema.id,
      customerId: fiadosSchema.customerId,
      saleId: fiadosSchema.saleId,
      notes: fiadosSchema.notes,
      originalAmount: fiadosSchema.originalAmount,
      dueDate: fiadosSchema.dueDate,
      status: fiadosSchema.status,
      createdAt: fiadosSchema.createdAt,
    })
    .from(fiadosSchema)
    .where(and(...conds));

  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map(r => r.id);
  const agg = await db
    .select({
      fiadoId: fiadoMovementsSchema.fiadoId,
      paid: sql<string>`COALESCE(SUM(${fiadoMovementsSchema.amount}) FILTER (WHERE ${fiadoMovementsSchema.type} = 'payment'), 0)::text`,
      last: sql<Date>`MAX(${fiadoMovementsSchema.createdAt})`,
    })
    .from(fiadoMovementsSchema)
    .where(inArray(fiadoMovementsSchema.fiadoId, ids))
    .groupBy(fiadoMovementsSchema.fiadoId);
  const aggById = new Map(agg.map(a => [a.fiadoId, a]));

  return rows.map((r) => {
    const a = aggById.get(r.id);
    const original = Number.parseFloat(r.originalAmount) || 0;
    const paid = a ? Number.parseFloat(a.paid) || 0 : 0;
    return {
      ...r,
      originalAmount: original,
      paid,
      balance: round2(Math.max(0, original - paid)),
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
  dueState: FiadoDueState;
  dueDays: number;
  lastMovementAt: string | null;
  fiadoCount: number;
  fiadoIds: string[];
};

function groupByClient(
  fiados: EnrichedFiado[],
  today: Date = new Date(),
): ClientDebt[] {
  const groups = new Map<string, EnrichedFiado[]>();
  for (const f of fiados) {
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
    const { name, phone } = parseClient(list[0]?.notes ?? null);
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
      fiadoCount: list.length,
      fiadoIds: list.map(f => f.id),
    });
  }

  return result;
}

export type FiadosMetrics = {
  pendingTotal: number;
  clientsWithDebt: number;
  overdue: number;
  dueSoon: number;
  recoveredThisMonth: number;
};

export type FiadosOverview = {
  metrics: FiadosMetrics;
  clients: ClientDebt[];
};

// Pendientes tab + dashboard metrics. Clients sorted most-urgent first.
export async function getFiadosOverview(
  organizationId: string,
): Promise<FiadosOverview> {
  const today = new Date();
  const pending = await fetchEnrichedFiados(organizationId, 'pending');
  const clients = groupByClient(pending, today).sort(
    (a, b) => a.dueDays - b.dueDays,
  );

  const [recovered] = await db
    .select({
      sum: sql<string>`COALESCE(SUM(${fiadoMovementsSchema.amount}) FILTER (WHERE ${fiadoMovementsSchema.type} = 'payment'), 0)::text`,
    })
    .from(fiadoMovementsSchema)
    .where(
      and(
        eq(fiadoMovementsSchema.organizationId, organizationId),
        sql`${fiadoMovementsSchema.createdAt} >= date_trunc('month', now() AT TIME ZONE 'America/Bogota')`,
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

// Historial tab: clients whose fiados are fully paid. Persisted forever.
export async function getFiadosHistory(
  organizationId: string,
): Promise<ClientDebt[]> {
  const paid = await fetchEnrichedFiados(organizationId, 'paid');
  return groupByClient(paid).sort((a, b) => {
    const at = a.lastMovementAt ? Date.parse(a.lastMovementAt) : 0;
    const bt = b.lastMovementAt ? Date.parse(b.lastMovementAt) : 0;
    return bt - at;
  });
}

// ── POS (cashier app) compatibility ──────────────────────────────────────────
// The cashier endpoints (/api/pos/fiados*) read from the SAME ledger as the
// dashboard so an abono on either surface stays consistent. These map the
// ledger onto the legacy JSON shape the cashier UI already expects.

export type PosFiadoSale = {
  id: string;
  total: number;
  paid: number;
  pending: number;
  createdAt: string;
  daysOld: number;
};

// Wire shape consumed by the cashier device (pos-merchatai FiadosCajero). Kept
// in snake_case on purpose — the device reads these exact keys. `id` IS the
// clientKey: the device passes it straight back to /pos/fiados/abonar and
// /pos/fiados/settle as `clientKey`.
export type PosFiadoClient = {
  id: string;
  client_name: string;
  client_phone: string | null;
  total_owed: number;
  days_overdue: number;
  risk_level: 'high' | 'mid' | 'low';
  status: 'pending' | 'partial' | 'settled';
  last_activity: string;
  notes: string | null;
  sales: PosFiadoSale[];
};

export type PosFiadosResult = {
  stats: {
    total_owed: number;
    urgent: number;
    remind: number;
    ok: number;
    total_clients: number;
  };
  clients: PosFiadoClient[];
};

function riskFromDueState(state: FiadoDueState): 'high' | 'mid' | 'low' {
  if (state === 'overdue') {
    return 'high';
  }
  if (state === 'due_soon') {
    return 'mid';
  }
  return 'low';
}

export async function getFiadosForPos(
  organizationId: string,
): Promise<PosFiadosResult> {
  const pending = await fetchEnrichedFiados(organizationId, 'pending');
  const today = new Date();

  const groups = new Map<string, EnrichedFiado[]>();
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

  const clients: PosFiadoClient[] = [];
  for (const [clientKey, list] of groups) {
    const { name, phone } = parseClient(list[0]?.notes ?? null);
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

// Maps paid fiado ids back to their origin sale ids, for the legacy
// `settledSaleIds` field in the cashier abono response.
export async function saleIdsForFiados(
  organizationId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) {
    return [];
  }
  const rows = await db
    .select({ saleId: fiadosSchema.saleId })
    .from(fiadosSchema)
    .where(
      and(
        eq(fiadosSchema.organizationId, organizationId),
        inArray(fiadosSchema.id, ids),
      ),
    );
  return rows.map(r => r.saleId).filter((x): x is string => x != null);
}

// Pending balance for a client, used by the cashier "marcar como pagado" path.
export async function getClientPendingBalance(
  organizationId: string,
  clientKey: string,
): Promise<number> {
  const pending = await fetchEnrichedFiados(organizationId, 'pending');
  return round2(
    pending
      .filter(f => clientKeyOf(f) === clientKey)
      .reduce((a, f) => a + f.balance, 0),
  );
}

// ── Read: single client detail + timeline ────────────────────────────────────

export type FiadoTimelineEntry = {
  id: string;
  fiadoId: string;
  type: 'charge' | 'payment' | 'extension' | 'writeoff' | 'adjustment';
  amount: number;
  method: string | null;
  dueDateBefore: string | null;
  dueDateAfter: string | null;
  note: string | null;
  createdBy: string | null;
  hitCaja: boolean;
  createdAt: string;
};

export type ClientDetail = {
  client: ClientDebt;
  fiados: {
    id: string;
    saleId: string | null;
    original: number;
    paid: number;
    balance: number;
    dueDate: string;
    status: 'pending' | 'paid' | 'written_off';
    dueState: FiadoDueState;
    dueDays: number;
    createdAt: string;
  }[];
  timeline: FiadoTimelineEntry[];
};

export async function getClientDetail(
  organizationId: string,
  clientKey: string,
): Promise<ClientDetail | null> {
  const all = await fetchEnrichedFiados(organizationId);
  const mine = all.filter(f => clientKeyOf(f) === clientKey);
  if (mine.length === 0) {
    return null;
  }

  const today = new Date();
  const [client] = groupByClient(mine, today);
  if (!client) {
    return null;
  }

  const fiados = mine
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
  const movements = await db
    .select({
      id: fiadoMovementsSchema.id,
      fiadoId: fiadoMovementsSchema.fiadoId,
      type: fiadoMovementsSchema.type,
      amount: fiadoMovementsSchema.amount,
      method: fiadoMovementsSchema.method,
      cashMovementId: fiadoMovementsSchema.cashMovementId,
      dueDateBefore: fiadoMovementsSchema.dueDateBefore,
      dueDateAfter: fiadoMovementsSchema.dueDateAfter,
      note: fiadoMovementsSchema.note,
      createdBy: fiadoMovementsSchema.createdBy,
      createdAt: fiadoMovementsSchema.createdAt,
    })
    .from(fiadoMovementsSchema)
    .where(inArray(fiadoMovementsSchema.fiadoId, ids))
    .orderBy(asc(fiadoMovementsSchema.createdAt));

  const timeline: FiadoTimelineEntry[] = movements.map(m => ({
    id: m.id,
    fiadoId: m.fiadoId,
    type: m.type,
    amount: Number.parseFloat(m.amount) || 0,
    method: m.method,
    dueDateBefore: m.dueDateBefore,
    dueDateAfter: m.dueDateAfter,
    note: m.note,
    createdBy: m.createdBy,
    hitCaja: m.cashMovementId != null,
    createdAt: m.createdAt.toISOString(),
  }));

  return { client, fiados, timeline };
}
