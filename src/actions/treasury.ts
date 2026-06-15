'use server';

import type { ActionResult } from '@/libs/action-result';
import type { TreasuryAccount } from '@/libs/treasury';
import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { requirePanelModule } from '@/libs/panel-session';
import { getTreasuryPosition, recordConsignacion } from '@/libs/treasury';

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
