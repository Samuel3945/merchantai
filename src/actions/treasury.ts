'use server';

import type { ActionResult } from '@/libs/action-result';
import type { TreasuryAccount, TreasuryAccountRow } from '@/libs/treasury';
import { currentUser } from '@clerk/nextjs/server';
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
  recordConsignacion,
} from '@/libs/treasury';

const CASH_PATH = '/dashboard/cash';

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

// Consignación: cash moved from the safe to a bank account. Lowers caja fuerte,
// raises the bank — makes the safe an exact balance.
export async function consignarABanco(
  toBankMethod: string,
  amount: number | string,
  note?: string | null,
): Promise<ActionResult<null>> {
  const { userId, orgId } = await requirePanelModule('cash');
  const method = toBankMethod.trim();
  if (!method) {
    return { ok: false, error: 'Elegí la cuenta bancaria' };
  }
  const amt = toMoney(amount);
  if (Number.parseFloat(amt) <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }
  const actor = await getActorName(userId);
  await recordConsignacion(db, {
    organizationId: orgId,
    toBankMethod: method,
    amount: amt,
    note,
    createdBy: actor,
  });
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'treasury.consignacion',
    entityType: 'treasury_transfer',
    entityId: orgId,
    after: { toBankMethod: method, amount: amt },
  });
  revalidatePath(CASH_PATH);
  return { ok: true, data: null };
}
