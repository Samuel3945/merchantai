'use server';

import type { ActionResult } from '@/libs/action-result';
import type { TreasuryAccount, TreasuryAccountRow, TreasuryTimelineEntry, TreasuryTimelinePage } from '@/libs/treasury';
import { auth, currentUser } from '@clerk/nextjs/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { requirePanelModule } from '@/libs/panel-session';
import {
  getSupplierOutstanding,
  recordSupplierPayment,
} from '@/libs/supplier-invoice-payment';
import {
  createTreasuryAccount,
  deleteTreasuryAccountToPending,
  ensurePaymentMethodAccounts,
  getTreasuryPosition,
  listTreasuryAccounts as listTreasuryAccountsLib,
  listTreasuryTimeline as listTreasuryTimelineLib,
  listTreasuryTimelinePage as listTreasuryTimelinePageLib,
  recordBankConsignacion,
  recordContainerTransfer,
  recordGastoOutflow,
} from '@/libs/treasury';
import { supplierPayablesSchema, suppliersSchema } from '@/models/Schema';

const CASH_PATH = '/dashboard/cash';
const TESORERIA_PATH = '/dashboard/tesoreria';

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

// Read-only treasury position for the owner. Gated by the Caja module (owner
// passes). Derived from existing data + the treasury ledger.
export async function getTreasury(): Promise<TreasuryAccount[]> {
  const { orgId } = await requirePanelModule('cash');
  return getTreasuryPosition(db, orgId);
}

// ── 2A: treasury_accounts server actions ─────────────────────────────────────
// All actions are gated by requirePanelModule('cash') — org admins pass
// unconditionally; non-owner members must hold the 'cash' module.

/** Creates a caja_fuerte (vault). Name must be unique within the org. */
export async function createCajaFuerte(
  name: string,
  openingBalance: number | string,
): Promise<ActionResult<TreasuryAccountRow>> {
  const { userId, orgId } = await requirePanelModule('cash');
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, error: 'El nombre de la caja fuerte es requerido' };
  }
  const actor = await getActorName(userId);
  try {
    const account = await createTreasuryAccount(db, {
      organizationId: orgId,
      type: 'caja_fuerte',
      name: trimmed,
      openingBalance,
      createdBy: actor,
    });
    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'treasury.account.created',
      entityType: 'treasury_account',
      entityId: account.id,
      after: { type: 'caja_fuerte', name: trimmed, openingBalance },
    });
    revalidatePath(CASH_PATH);
    return { ok: true, data: account };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al crear la caja fuerte',
    };
  }
}

/**
 * Creates a banco account. A banco is first and foremost a storage container
 * for money you already hold. Linking a payment method is OPTIONAL: when set,
 * confirmed transfers paid with that method auto-deposit into this account
 * (see resolveBancoForMethod); when omitted, it's a manual container you move
 * money into yourself (consignaciones, transfers).
 */
export async function createBanco(
  name: string,
  paymentMethodId: string | null,
  openingBalance: number | string,
): Promise<ActionResult<TreasuryAccountRow>> {
  const { userId, orgId } = await requirePanelModule('cash');
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, error: 'El nombre de la cuenta bancaria es requerido' };
  }
  const linkedMethodId = paymentMethodId && paymentMethodId.length > 0 ? paymentMethodId : null;
  const actor = await getActorName(userId);
  try {
    const account = await createTreasuryAccount(db, {
      organizationId: orgId,
      type: 'banco',
      name: trimmed,
      openingBalance,
      paymentMethodId: linkedMethodId,
      createdBy: actor,
    });
    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'treasury.account.created',
      entityType: 'treasury_account',
      entityId: account.id,
      after: { type: 'banco', name: trimmed, paymentMethodId: linkedMethodId, openingBalance },
    });
    revalidatePath(CASH_PATH);
    return { ok: true, data: account };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al crear la cuenta bancaria',
    };
  }
}

/** Returns active treasury accounts for the org. */
export async function listTreasuryAccounts(): Promise<TreasuryAccountRow[]> {
  const { userId, orgId } = await requirePanelModule('cash');
  // Lazy, idempotent backfill: ensure every money-holding payment method has its
  // linked banco account before listing. Best-effort — never blocks the read.
  await ensurePaymentMethodAccounts(db, orgId, await getActorName(userId)).catch(
    () => {},
  );
  return listTreasuryAccountsLib(db, orgId);
}

/**
 * Deletes a treasury container (caja_fuerte / banco). Owner-only. The account's
 * remaining balance is moved to "Pendiente de ubicar" and the row is soft-deleted
 * (active=false) so historical movements stay intact. Returns the amount moved so
 * the UI can confirm it to the user.
 */
export async function deleteAccount(
  accountId: string,
): Promise<ActionResult<{ movedAmount: number }>> {
  // Owner-only: deleting a container is an owner-level treasury operation, the
  // same gate transferEntreCajas uses — re-assert org:admin regardless of grants.
  const { orgRole } = await auth();
  if (orgRole !== 'org:admin') {
    return { ok: false, error: 'Solo el propietario puede eliminar cuentas de tesorería' };
  }
  const { userId, orgId } = await requirePanelModule('cash');
  if (!accountId) {
    return { ok: false, error: 'accountId es requerido' };
  }
  // A composite display key (e.g. "banco:Nequi") is never a real account id.
  if (accountId.includes(':')) {
    return { ok: false, error: 'Identificador de cuenta inválido' };
  }
  const actor = await getActorName(userId);
  try {
    const result = await db.transaction(tx =>
      deleteTreasuryAccountToPending(tx, {
        accountId,
        organizationId: orgId,
        createdBy: actor,
      }),
    );
    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'treasury.account.deleted',
      entityType: 'treasury_account',
      entityId: accountId,
      after: { active: false, movedToPending: result.movedAmount },
    });
    revalidatePath(CASH_PATH);
    revalidatePath(TESORERIA_PATH);
    return { ok: true, data: { movedAmount: result.movedAmount } };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al eliminar la cuenta',
    };
  }
}

// ── 2B: treasury_movements transfer actions ───────────────────────────────────

/**
 * Caja-to-caja (or any container-to-container) transfer using the new
 * treasury_movements ledger. Restricted to org:admin (owner-only) — this is an
 * owner-level physical cash rebalance, not a cashier operation.
 *
 * In Phase 2 this is LEDGER-ONLY: caja balances still derive from cash sessions
 * (Phase 1 path). The treasury_movements row is an audit entry that tracks the
 * declared rebalance. Native caja ledger migration = Phase 3.
 */
export async function transferEntreCajas(
  fromAccountId: string,
  toAccountId: string,
  amount: number | string,
  reason?: string | null,
): Promise<ActionResult<null>> {
  // Owner-only gate: re-assert org:admin regardless of module grants.
  const { orgRole } = await auth();
  if (orgRole !== 'org:admin') {
    return {
      ok: false,
      error: 'Solo el propietario puede realizar transferencias entre contenedores',
    };
  }
  const { userId, orgId } = await requirePanelModule('cash');

  if (!fromAccountId || !toAccountId) {
    return { ok: false, error: 'Cuenta de origen y destino son requeridos' };
  }
  // Defense-in-depth: this action moves money between ledger-backed accounts and
  // expects real treasury_accounts ids. A composite display key (e.g.
  // "banco:Nequi" or "caja:<token>") is never a valid account id — reject it with
  // a clean error instead of letting it crash the `WHERE id = ...` query.
  if (fromAccountId.includes(':') || toAccountId.includes(':')) {
    return { ok: false, error: 'Identificador de cuenta inválido' };
  }
  if (fromAccountId === toAccountId) {
    return { ok: false, error: 'Las cuentas de origen y destino deben ser diferentes' };
  }
  const amt = toMoney(amount);
  if (Number.parseFloat(amt) <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }

  const actor = await getActorName(userId);
  try {
    await recordContainerTransfer(db, {
      organizationId: orgId,
      fromAccountId,
      toAccountId,
      amount: amt,
      createdBy: actor,
      reason: reason ?? null,
    });
    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'treasury.transfer',
      entityType: 'treasury_movement',
      entityId: orgId,
      after: { fromAccountId, toAccountId, amount: amt, reason },
    });
    revalidatePath(CASH_PATH);
    return { ok: true, data: null };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al realizar la transferencia',
    };
  }
}

/**
 * Records a consignación into a banco account using the treasury_movements
 * ledger (FK-based, UUID-keyed). Both source container and banco must be
 * active and have sufficient balance. treasury_transfers is now read-only
 * for audit history (Phase 2D — writes retired).
 */
export async function consignarDesde(
  fromAccountId: string,
  toBankAccountId: string,
  amount: number | string,
  note?: string | null,
): Promise<ActionResult<null>> {
  const { userId, orgId } = await requirePanelModule('cash');

  if (!fromAccountId || !toBankAccountId) {
    return { ok: false, error: 'Cuenta de origen y banco de destino son requeridos' };
  }
  const amt = toMoney(amount);
  if (Number.parseFloat(amt) <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }

  const actor = await getActorName(userId);
  try {
    await recordBankConsignacion(db, {
      organizationId: orgId,
      fromAccountId,
      toBankAccountId,
      amount: amt,
      createdBy: actor,
      note: note ?? null,
    });
    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'treasury.consignacion',
      entityType: 'treasury_movement',
      entityId: orgId,
      after: { fromAccountId, toBankAccountId, amount: amt },
    });
    revalidatePath(CASH_PATH);
    return { ok: true, data: null };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al realizar la consignación',
    };
  }
}

// ── 2C: gasto as treasury outflow (dual linked record) ───────────────────────

/**
 * Registers a gasto that:
 * (a) inserts one `expenses` row for P&L (net-profit.ts reads this unchanged)
 * (b) inserts one `treasury_movements` row (type='gasto', from=selectedContainerId)
 * Both writes are atomic — partial state is prohibited (REQ-4).
 *
 * Gated by requirePanelModule('cash').
 * Source container balance is checked before any insert.
 */
export async function recordGasto(input: {
  fromAccountId: string;
  amount: number | string;
  category: string;
  description?: string | null;
  incurredOn: string; // ISO date string 'YYYY-MM-DD'
}): Promise<ActionResult<{ expenseId: string }>> {
  const { userId, orgId } = await requirePanelModule('cash');

  if (!input.fromAccountId) {
    return { ok: false, error: 'Contenedor de origen requerido' };
  }
  const amt = toMoney(input.amount);
  if (Number.parseFloat(amt) <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }
  if (!input.category?.trim()) {
    return { ok: false, error: 'La categoría es requerida' };
  }
  // Carry over the 'otros'-requires-description rule from the deleted
  // createExpense action (M1): a free-form category demands an explanation so
  // the gasto is auditable. Enforced server-side, not only in the form.
  if (input.category.trim() === 'otros' && !input.description?.trim()) {
    return { ok: false, error: 'La descripción es requerida para "Otros"' };
  }
  if (!input.incurredOn) {
    return { ok: false, error: 'La fecha del gasto es requerida' };
  }

  const actor = await getActorName(userId);
  try {
    const expenseId = await recordGastoOutflow(db, {
      organizationId: orgId,
      fromAccountId: input.fromAccountId,
      amount: amt,
      category: input.category.trim(),
      description: input.description?.trim() || null,
      incurredOn: input.incurredOn,
      createdBy: actor,
    });
    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'treasury.gasto',
      entityType: 'expense',
      entityId: expenseId,
      after: {
        fromAccountId: input.fromAccountId,
        amount: amt,
        category: input.category,
        incurredOn: input.incurredOn,
      },
    });
    revalidatePath(CASH_PATH);
    revalidatePath(TESORERIA_PATH);
    return { ok: true, data: { expenseId } };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al registrar el gasto',
    };
  }
}

// ── recordSupplierPaymentFromConsole ─────────────────────────────────────────
// Treasury-funded supplier payment from the treasury console (owner/panel).
// Settles the supplier's open/partial payables oldest-first from a chosen
// cofre/banco account. No P&L entry — this is an ASSET debit (supplier debt
// settlement), not a gasto. Use recordGasto for generic P&L expenses.
//
// Gated by requirePanelModule('cash'). Reuses recordSupplierPayment with
// fundingSource:{kind:'treasury', accountId}.

export async function recordSupplierPaymentFromConsole(input: {
  supplierId: string;
  fromAccountId: string;
  amount: number | string;
  note?: string | null;
}): Promise<ActionResult<{ appliedTotal: number; settledPayables: number }>> {
  const { userId, orgId } = await requirePanelModule('cash');

  if (!input.supplierId?.trim()) {
    return { ok: false, error: 'Proveedor requerido' };
  }
  if (!input.fromAccountId?.trim()) {
    return { ok: false, error: 'Contenedor de origen requerido' };
  }
  const amt = Number.parseFloat(toMoney(input.amount));
  if (amt <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }

  const actor = await getActorName(userId);

  try {
    const result = await recordSupplierPayment(db, {
      organizationId: orgId,
      supplierId: input.supplierId,
      fundingSource: { kind: 'treasury', accountId: input.fromAccountId },
      amount: amt,
      createdBy: actor,
      note: input.note ?? null,
    });

    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'treasury.supplier.settled',
      entityType: 'supplier_payment',
      entityId: input.supplierId,
      after: {
        supplierId: input.supplierId,
        fromAccountId: input.fromAccountId,
        amount: amt,
        appliedTotal: result.appliedTotal,
      },
    });

    revalidatePath(CASH_PATH);
    revalidatePath(TESORERIA_PATH);
    return {
      ok: true,
      data: {
        appliedTotal: result.appliedTotal,
        settledPayables: result.breakdown.length,
      },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al registrar el pago a proveedor',
    };
  }
}

// ── listSuppliersWithOutstanding ─────────────────────────────────────────────
// Returns suppliers that have open/partial payables (totalOutstanding > 0).
// Used by the treasury console "Pagar proveedor" modal to populate the supplier
// picker with only actionable suppliers.

export type SupplierOutstandingRow = {
  supplierId: string;
  name: string;
  totalOutstanding: number;
};

export async function listSuppliersWithOutstanding(): Promise<
  ActionResult<{ orgId: string; rawCount: number; rows: SupplierOutstandingRow[] }>
> {
  const { orgId } = await requirePanelModule('cash');
  // TEMP server-side diagnostic — reliable channel (Easypanel container logs).
  console.warn(`[DIAG-TREASURY] resolved orgId=${orgId}`);

  try {
    // Aggregate outstanding per supplier DIRECTLY from supplier_payables, then
    // resolve the name via LEFT JOIN with an explicit ::text cast — supplier_id
    // is TEXT while suppliers.id is uuid, so a plain id match silently returns
    // nothing (the bug that hid debts from this modal). Mirrors listOpenInvoices:
    // a payable whose supplier_id has no matching suppliers row still surfaces,
    // with a fallback name. The SUM matches the per-supplier figure the POS shows
    // (getSupplierOutstanding) so both screens agree.
    const grouped = await db
      .select({
        supplierId: supplierPayablesSchema.supplierId,
        name: suppliersSchema.name,
        totalOutstanding: sql<string>`COALESCE(SUM(
          CAST(${supplierPayablesSchema.totalAmount} AS numeric)
            - CAST(${supplierPayablesSchema.paidAmount} AS numeric)
            - CAST(COALESCE(${supplierPayablesSchema.creditedAmount}, '0') AS numeric)
        ), 0)::text`,
      })
      .from(supplierPayablesSchema)
      .leftJoin(
        suppliersSchema,
        sql`${suppliersSchema.id}::text = ${supplierPayablesSchema.supplierId}`,
      )
      .where(
        and(
          eq(supplierPayablesSchema.organizationId, orgId),
          inArray(supplierPayablesSchema.status, ['open', 'partial']),
        ),
      )
      .groupBy(supplierPayablesSchema.supplierId, suppliersSchema.name);

    const rows: SupplierOutstandingRow[] = grouped
      .map(r => ({
        supplierId: r.supplierId,
        name: r.name ?? 'Proveedor sin nombre',
        totalOutstanding: Number.parseFloat(r.totalOutstanding),
      }))
      .filter(r => r.totalOutstanding > 0)
      .sort((a, b) => b.totalOutstanding - a.totalOutstanding);

    // TEMP diagnostic: raw count of open/partial payables for THIS resolved org
    // (no suppliers join), surfaced in the modal to confirm whether the panel is
    // querying the same org that holds the debt the POS can see.
    const [countRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(supplierPayablesSchema)
      .where(
        and(
          eq(supplierPayablesSchema.organizationId, orgId),
          inArray(supplierPayablesSchema.status, ['open', 'partial']),
        ),
      );

    console.warn(
      `[DIAG-TREASURY] orgId=${orgId} rawOpenPayables=${countRow?.c ?? 0} groupedSuppliers=${rows.length}`,
    );
    return { ok: true, data: { orgId, rawCount: countRow?.c ?? 0, rows } };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al obtener proveedores con saldo',
    };
  }
}

// ── getSupplierInvoicesAction ─────────────────────────────────────────────────
// Returns per-invoice outstanding breakdown for a given supplier.
// Used by the treasury "Pagar proveedor" modal to show the invoice list.

export type SupplierInvoiceRow = {
  payableId: string;
  invoiceNumber: string | null;
  purchasedAt: Date;
  outstanding: number;
  status: 'open' | 'partial';
};

export async function getSupplierInvoicesAction(
  supplierId: string,
): Promise<ActionResult<SupplierInvoiceRow[]>> {
  const { orgId } = await requirePanelModule('cash');
  try {
    const result = await getSupplierOutstanding(db, orgId, supplierId);
    return { ok: true, data: result.invoices };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al obtener facturas del proveedor',
    };
  }
}

// ── Slice C: Financial Timeline ───────────────────────────────────────────────

/**
 * Returns the financial timeline for the org — treasury_movements ordered
 * newest-first with account names resolved. Read-only.
 *
 * @param limit - optional max rows (default 100)
 */
export async function getTimeline(
  limit?: number,
): Promise<TreasuryTimelineEntry[]> {
  const { orgId } = await requirePanelModule('cash');
  return listTreasuryTimelineLib(db, orgId, limit);
}

/**
 * Filtered + paginated treasury timeline for the full-history page. Gated by
 * requirePanelModule('cash'). Page size is clamped to [1, 100]; page is 1-based.
 */
export async function getTimelinePage(input: {
  start?: string;
  end?: string;
  type?: string;
  accountId?: string;
  page?: number;
  pageSize?: number;
}): Promise<TreasuryTimelinePage> {
  const { orgId } = await requirePanelModule('cash');
  const pageSize = Math.min(Math.max(input.pageSize ?? 25, 1), 100);
  const page = Math.max(1, input.page ?? 1);
  return listTreasuryTimelinePageLib(db, orgId, {
    start: input.start,
    end: input.end,
    type: input.type,
    accountId: input.accountId,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
}

// ── Slice 2: Unified gastos history ──────────────────────────────────────────

/**
 * Lists all gastos for the org from the expenses table with origin resolution.
 * Gated by requirePanelModule('cash'). Supports date-range and category filters.
 */
export async function listGastosAction(input: {
  start: string;
  end: string;
  category?: string;
}) {
  const { listGastos } = await import('@/libs/gastos');
  const { orgId } = await requirePanelModule('cash');
  return listGastos(db, {
    organizationId: orgId,
    start: input.start,
    end: input.end,
    category: input.category,
  });
}

// ── Slice 3: Delete-as-correction (REQ-8) ────────────────────────────────────

/**
 * Posts a referenced reversing correction for a posted gasto.
 * The original expenses row is NEVER mutated — ADR-3 immutability.
 *
 * For treasury-sourced gastos: inserts a negative expenses row + a compensating
 * treasury_movements entrada to restore the container balance.
 * For POS-sourced gastos: inserts only a negative expenses row (drawer side
 * stays read-only — arqueo concern).
 *
 * Owner-only: gated via requireOwnerContext (org:admin).
 */
export async function correctGastoAction(
  expenseId: string,
): Promise<ActionResult<{ reversalExpenseId: string }>> {
  const { userId, orgId } = await auth().then(async (a) => {
    if (!a.userId || !a.orgId) {
      throw new Error('Not authenticated');
    }
    if (a.orgRole !== 'org:admin') {
      throw new Error('Solo el dueño puede corregir gastos');
    }
    return { userId: a.userId, orgId: a.orgId };
  });

  if (!expenseId?.trim()) {
    return { ok: false, error: 'ID de gasto requerido' };
  }

  const { correctGastoExpense } = await import('@/libs/expense-correction');

  try {
    const result = await correctGastoExpense(db, {
      organizationId: orgId,
      expenseId,
      correctedBy: userId,
    });

    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'expense.corrected',
      entityType: 'expense',
      entityId: expenseId,
      after: { reversalExpenseId: result.reversalExpenseId },
    });

    revalidatePath('/dashboard/tesoreria');
    revalidatePath('/dashboard');

    return { ok: true, data: { reversalExpenseId: result.reversalExpenseId } };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return { ok: false, error: message };
  }
}

// treasury-sweep-model slice 2: HandoverToggle / getTreasuryHandoverSettings /
// setTreasuryHandoverEnabled removed. The at-close handover was retired in slice 1;
// the flag is now dead. Per-caja sweep destination config is in actions/pos-tokens.ts.
