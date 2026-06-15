'use server';

import type { ActionResult } from '@/libs/action-result';
import type {
  ReconciliationStatus,
  TransferReconciliation,
} from '@/libs/transfer-reconciliation';
import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { requirePanelModule } from '@/libs/panel-session';
import {
  bulkConfirmPending,
  confirmReconciliation,
  countPendingReconciliations,
  listReconciliations,
  markReconciliationMismatch,
  markReconciliationNotArrived,
} from '@/libs/transfer-reconciliation';

// Transfer reconciliation is the digital counterpart of the cash arqueo, so it
// lives under the Caja ('cash') module. The owner (org:admin) passes the gate
// unconditionally; a panel member needs the module. (Confirming from a POS
// device — gated by canConfirmTransfers — is a separate, later surface.)
const MODULE = 'cash';
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

export async function listTransferReconciliations(filter?: {
  status?: ReconciliationStatus;
  from?: Date;
  to?: Date;
}): Promise<ActionResult<TransferReconciliation[]>> {
  const { orgId } = await requirePanelModule(MODULE);
  const rows = await listReconciliations(db, { organizationId: orgId, ...filter });
  return { ok: true, data: rows };
}

export async function getPendingTransfersOverview(period?: {
  from?: Date;
  to?: Date;
}): Promise<ActionResult<{ count: number; total: number }>> {
  const { orgId } = await requirePanelModule(MODULE);
  const overview = await countPendingReconciliations(db, {
    organizationId: orgId,
    ...period,
  });
  return { ok: true, data: overview };
}

export async function confirmTransfer(
  id: string,
  arrivedAmount?: number | string | null,
): Promise<ActionResult<TransferReconciliation>> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const actor = await getActorName(userId);
  const row = await confirmReconciliation(db, {
    id,
    organizationId: orgId,
    reconciledBy: actor,
    arrivedAmount,
  });
  if (!row) {
    return { ok: false, error: 'Transferencia no encontrada' };
  }
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'transfer.confirmed',
    entityType: 'transfer_reconciliation',
    entityId: row.id,
    after: { status: row.status, arrivedAmount: row.arrivedAmount },
  });
  revalidatePath(CASH_PATH);
  return { ok: true, data: row };
}

export async function markTransferNotArrived(
  id: string,
  note?: string | null,
): Promise<ActionResult<TransferReconciliation>> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const actor = await getActorName(userId);
  const row = await markReconciliationNotArrived(db, {
    id,
    organizationId: orgId,
    reconciledBy: actor,
    note,
  });
  if (!row) {
    return { ok: false, error: 'Transferencia no encontrada' };
  }
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'transfer.not_arrived',
    entityType: 'transfer_reconciliation',
    entityId: row.id,
    after: { status: row.status, note: row.note },
  });
  revalidatePath(CASH_PATH);
  return { ok: true, data: row };
}

export async function markTransferMismatch(
  id: string,
  arrivedAmount: number | string,
  note?: string | null,
): Promise<ActionResult<TransferReconciliation>> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const actor = await getActorName(userId);
  const row = await markReconciliationMismatch(db, {
    id,
    organizationId: orgId,
    reconciledBy: actor,
    arrivedAmount,
    note,
  });
  if (!row) {
    return { ok: false, error: 'Transferencia no encontrada' };
  }
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'transfer.mismatch',
    entityType: 'transfer_reconciliation',
    entityId: row.id,
    after: {
      status: row.status,
      expectedAmount: row.expectedAmount,
      arrivedAmount: row.arrivedAmount,
    },
  });
  revalidatePath(CASH_PATH);
  return { ok: true, data: row };
}

export async function confirmAllPendingTransfers(
  period?: { ids?: string[]; from?: Date; to?: Date },
): Promise<ActionResult<{ confirmed: number }>> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const actor = await getActorName(userId);
  const confirmed = await bulkConfirmPending(db, {
    organizationId: orgId,
    reconciledBy: actor,
    ...period,
  });
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'transfer.bulk_confirmed',
    entityType: 'transfer_reconciliation',
    entityId: orgId,
    after: { confirmed },
  });
  revalidatePath(CASH_PATH);
  return { ok: true, data: { confirmed } };
}
