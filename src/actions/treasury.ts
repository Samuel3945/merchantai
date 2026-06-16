'use server';

import type { ActionResult } from '@/libs/action-result';
import type { TreasuryAccount, TreasuryAccountRow, TreasuryTimelineEntry } from '@/libs/treasury';
import { auth, currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { requirePanelModule } from '@/libs/panel-session';
import {
  createTreasuryAccount,
  deactivateTreasuryAccount,
  getTreasuryPosition,
  listTreasuryAccounts as listTreasuryAccountsLib,
  listTreasuryTimeline as listTreasuryTimelineLib,
  recordBankConsignacion,
  recordContainerTransfer,
  recordGastoOutflow,
} from '@/libs/treasury';

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

/** Creates a banco account linked to a payment_methods row. */
export async function createBanco(
  name: string,
  paymentMethodId: string,
  openingBalance: number | string,
): Promise<ActionResult<TreasuryAccountRow>> {
  const { userId, orgId } = await requirePanelModule('cash');
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, error: 'El nombre de la cuenta bancaria es requerido' };
  }
  if (!paymentMethodId) {
    return {
      ok: false,
      error: 'La cuenta bancaria debe estar vinculada a un método de pago',
    };
  }
  const actor = await getActorName(userId);
  try {
    const account = await createTreasuryAccount(db, {
      organizationId: orgId,
      type: 'banco',
      name: trimmed,
      openingBalance,
      paymentMethodId,
      createdBy: actor,
    });
    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'treasury.account.created',
      entityType: 'treasury_account',
      entityId: account.id,
      after: { type: 'banco', name: trimmed, paymentMethodId, openingBalance },
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
  const { orgId } = await requirePanelModule('cash');
  return listTreasuryAccountsLib(db, orgId);
}

/** Soft-deletes a treasury account (active → false). Row is kept for history. */
export async function deactivateAccount(
  accountId: string,
): Promise<ActionResult<null>> {
  const { userId, orgId } = await requirePanelModule('cash');
  if (!accountId) {
    return { ok: false, error: 'accountId es requerido' };
  }
  await deactivateTreasuryAccount(db, accountId, orgId);
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'treasury.account.deactivated',
    entityType: 'treasury_account',
    entityId: accountId,
    after: { active: false },
  });
  revalidatePath(CASH_PATH);
  return { ok: true, data: null };
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

// ── Slice C: Financial Timeline ───────────────────────────────────────────────

export type { TreasuryTimelineEntry };

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
