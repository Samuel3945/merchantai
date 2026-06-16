'use server';

import type { ActionResult } from '@/libs/action-result';
import type {
  ReconciliationStatus,
  ResolutionType,
  TransferReconciliation,
} from '@/libs/transfer-reconciliation';
import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { ActionValidationError } from '@/libs/action-result';
import { logAction } from '@/libs/audit-log';
import { findOrCreateOpenSession } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { createFiado } from '@/libs/fiados';
import { parseClient } from '@/libs/fiados-math';
import { requirePanelModule } from '@/libs/panel-session';
import { reclassifyPayment } from '@/libs/payment-reclassification';
import {
  bulkConfirmPending,
  confirmReconciliation,
  countPendingReconciliations,
  countReconciliationsByStatus,
  getReconciliationById,
  getReconciliationSale,
  listReconciliations,
  markReconciliationMismatch,
  markReconciliationNotArrived,
  outstandingAmount,
  recordCashierExplanation,
  setReconciliationResolution,
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

// Approval-inbox header counts: pendientes, confirmados hoy, no llegaron.
// "Hoy" is the America/Bogota calendar day (fixed UTC-5, no DST).
export async function getTransferStatusCounts(): Promise<
  ActionResult<{ pending: number; confirmedToday: number; notArrived: number }>
> {
  const { orgId } = await requirePanelModule(MODULE);
  const bogotaDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
  }).format(new Date());
  const confirmedSince = new Date(`${bogotaDate}T00:00:00-05:00`);
  const counts = await countReconciliationsByStatus(db, {
    organizationId: orgId,
    confirmedSince,
  });
  return { ok: true, data: counts };
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

// The cashier on duty explains the comprobante they confirmed for a transfer
// under investigation. Recorded async — the owner may have flagged it days ago.
export async function recordTransferExplanation(
  id: string,
  explanation: string,
): Promise<ActionResult<TransferReconciliation>> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const text = explanation.trim();
  if (!text) {
    return { ok: false, error: 'La explicación no puede estar vacía' };
  }
  const actor = await getActorName(userId);
  const row = await recordCashierExplanation(db, {
    id,
    organizationId: orgId,
    explanation: text,
    explainedBy: actor,
  });
  if (!row) {
    return { ok: false, error: 'Transferencia no encontrada' };
  }
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'transfer.explained',
    entityType: 'transfer_reconciliation',
    entityId: row.id,
    after: { cashierExplainedBy: row.cashierExplainedBy },
  });
  revalidatePath(CASH_PATH);
  return { ok: true, data: row };
}

// Closes the investigation of a not_arrived / mismatch transfer with an outcome.
// 'receivable' is only legal for a sale with a known customer (honest error) and
// books a fiado for the outstanding amount — atomically with the resolution.
// 'loss' and 'cashier_liability' just record the outcome; the audit trail is the
// fraud signal (alerts are computed, not stored).
export async function resolveTransfer(
  id: string,
  resolutionType: ResolutionType,
): Promise<ActionResult<TransferReconciliation>> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const actor = await getActorName(userId);

  try {
    const resolved = await db.transaction(async (tx) => {
      const row = await getReconciliationById(tx, { id, organizationId: orgId });
      if (!row) {
        throw new ActionValidationError('Transferencia no encontrada');
      }

      let resolutionFiadoId: string | null = null;
      if (resolutionType === 'receivable') {
        if (!row.salePaymentId) {
          throw new ActionValidationError(
            'Solo una venta con cliente puede pasar a fiado',
          );
        }
        const sale = await getReconciliationSale(tx, row.salePaymentId);
        const client = parseClient(sale?.notes ?? null);
        if (!sale || !client.name) {
          throw new ActionValidationError(
            'La venta no tiene cliente; marcá pérdida o responsabilidad del cajero',
          );
        }
        const owed = outstandingAmount(row);
        if (owed <= 0) {
          throw new ActionValidationError('No hay saldo pendiente para cobrar');
        }
        const fiado = await createFiado(tx, {
          organizationId: orgId,
          saleId: sale.saleId,
          originalAmount: owed,
          createdBy: actor,
          notes: sale.notes,
        });
        if (!fiado) {
          throw new ActionValidationError('No se pudo crear el fiado');
        }
        resolutionFiadoId = fiado.id;
      }

      const updated = await setReconciliationResolution(tx, {
        id,
        organizationId: orgId,
        resolutionType,
        resolvedBy: actor,
        resolutionFiadoId,
      });
      if (!updated) {
        throw new Error('No se pudo resolver la transferencia');
      }
      return updated;
    });

    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: `transfer.resolved.${resolutionType}`,
      entityType: 'transfer_reconciliation',
      entityId: resolved.id,
      after: {
        resolutionType: resolved.resolutionType,
        resolutionFiadoId: resolved.resolutionFiadoId,
      },
    });
    revalidatePath(CASH_PATH);
    return { ok: true, data: resolved };
  } catch (err) {
    if (err instanceof ActionValidationError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

// Corrects a mis-entered payment split (e.g. a mixed payment booked as all-cash):
// moves an amount from one method to another on a sale. The total and stock are
// untouched. The cash delta posts as a signed reclassification in the current
// open session; a new transfer gets a reconciliation row to confirm later.
export async function reclassifySalePayment(
  salePaymentId: string,
  toMethod: string,
  amount: number | string,
): Promise<ActionResult<null>> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const actor = await getActorName(userId);

  try {
    await db.transaction(async (tx) => {
      // Auto-open the panel session — the owner never opens a caja here.
      const open = await findOrCreateOpenSession(tx, {
        organizationId: orgId,
        openedBy: actor,
      });
      const result = await reclassifyPayment(tx, {
        organizationId: orgId,
        salePaymentId,
        toMethod,
        amount,
        currentSessionId: open.id,
        createdBy: actor,
      });
      if (!result.ok) {
        throw new ActionValidationError(result.error);
      }
    });
  } catch (err) {
    if (err instanceof ActionValidationError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'transfer.reclassified',
    entityType: 'sale_payment',
    entityId: salePaymentId,
    after: { toMethod, amount: String(amount) },
  });
  revalidatePath(CASH_PATH);
  return { ok: true, data: null };
}
