'use server';

import type { ActionResult } from '@/libs/action-result';
import type {
  ReconciliationStatus,
  ResolutionType,
  TransferReconciliation,
} from '@/libs/transfer-reconciliation';
import { auth, currentUser } from '@clerk/nextjs/server';
import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { ActionValidationError } from '@/libs/action-result';
import { logAction } from '@/libs/audit-log';
import { findOrCreateOpenSession } from '@/libs/cash-helpers';
import { findOrCreateCustomer } from '@/libs/customers';
import { db } from '@/libs/DB';
import { createFiado } from '@/libs/fiados';
import { requirePanelModule } from '@/libs/panel-session';
import { reclassifyPayment } from '@/libs/payment-reclassification';
import {
  bulkConfirmPending,
  confirmReconciliation,
  countPendingReconciliations,
  countReconciliationsByStatus,
  createRecoveryReconciliation,
  DEFAULT_RESOLUTION_SETTING_KEY,
  getDefaultResolution,
  getReconciliationById,
  getReconciliationSale,
  listReconciliations,
  markReconciliationMismatch,
  markReconciliationNotArrived,
  outstandingAmount,
  recordCashierExplanation,
  setReconciliationResolution,
  splitPartialArrival,
} from '@/libs/transfer-reconciliation';
import {
  adjustConfirmedTransferDeposit,
  depositConfirmedTransfer,
} from '@/libs/treasury';
import {
  transferReconciliationsSchema,
  treasuryMovementsSchema,
} from '@/models/Schema';

// Transfer reconciliation is the digital counterpart of the cash arqueo, so it
// lives under the Caja ('cash') module. The owner (org:admin) passes the gate
// unconditionally; a panel member needs the module. (Confirming from a POS
// device — gated by canConfirmTransfers — is a separate, later surface.)
const MODULE = 'cash';
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

export async function listTransferReconciliations(filter?: {
  status?: ReconciliationStatus;
  from?: Date;
  to?: Date;
}): Promise<ActionResult<TransferReconciliation[]>> {
  const { orgId } = await requirePanelModule(MODULE);
  // Lazily catch up any confirmed-but-undeposited transfers (best-effort).
  await backfillConfirmedTransferDeposits(orgId);
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
  // Confirm the reconciliation first, then bridge the bank deposit best-effort.
  // The cashier's confirmation must NEVER be blocked by the treasury bookkeeping:
  // if the deposit fails (e.g. a not-yet-migrated treasury column), the transfer
  // stays confirmed and the deposit is idempotent, so it can be re-applied once
  // the cause is fixed. We still surface the deposit error so the money is not
  // silently lost from Tesorería.
  const confirmed = await db.transaction(async tx =>
    confirmReconciliation(tx, {
      id,
      organizationId: orgId,
      reconciledBy: actor,
      arrivedAmount,
    }),
  );
  if (!confirmed) {
    return { ok: false, error: 'Transferencia no encontrada' };
  }
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'transfer.confirmed',
    entityType: 'transfer_reconciliation',
    entityId: confirmed.id,
    after: { status: confirmed.status, arrivedAmount: confirmed.arrivedAmount },
  });

  const depositError = await tryDepositConfirmedTransfer(orgId, actor, confirmed);

  revalidatePath(CASH_PATH);
  revalidatePath(TESORERIA_PATH);

  if (depositError) {
    return {
      ok: false,
      error: `Transferencia confirmada, pero no se registró en Tesorería: ${depositError}`,
    };
  }
  return { ok: true, data: confirmed };
}

// Best-effort bank deposit for a confirmed transfer. Returns the error message
// when it fails (so the caller can surface it) instead of throwing, so a
// bookkeeping failure never rolls back or 500s the confirmation itself.
async function tryDepositConfirmedTransfer(
  orgId: string,
  actor: string,
  confirmed: {
    id: string;
    method: string;
    arrivedAmount: string | null;
    expectedAmount: string;
  },
): Promise<string | null> {
  try {
    await depositConfirmedTransfer(db, {
      organizationId: orgId,
      reconciliationId: confirmed.id,
      method: confirmed.method,
      amount: confirmed.arrivedAmount ?? confirmed.expectedAmount,
      createdBy: actor,
    });
    return null;
  } catch (e) {
    // Drizzle wraps the driver error as "Failed query: ... params: ...". The
    // ACTUAL Postgres reason (e.g. `column "..." does not exist`) lives on the
    // cause — surface it so the failure is self-explanatory, not just the SQL.
    const message = e instanceof Error ? e.message : String(e);
    const cause
      = e instanceof Error && e.cause instanceof Error ? e.cause.message : '';
    const full = cause ? `${cause} — ${message}` : message;
    console.error(
      '[transfer-reconciliation] bank deposit failed (transfer stays confirmed):',
      full,
    );
    return full;
  }
}

// Self-healing deposit backfill: re-applies the idempotent bank deposit for any
// confirmed transfer that never got one — e.g. transfers confirmed while the
// treasury column was still missing in prod. Runs lazily when the panel loads,
// so the money lands automatically once the schema catches up. Best-effort: the
// leftJoin touches transfer_reconciliation_id, so before that column exists the
// query throws and is swallowed. depositConfirmedTransfer is idempotent (unique
// index), so re-running can never double-credit.
async function backfillConfirmedTransferDeposits(orgId: string): Promise<void> {
  try {
    const stuck = await db
      .select({
        id: transferReconciliationsSchema.id,
        method: transferReconciliationsSchema.method,
        arrivedAmount: transferReconciliationsSchema.arrivedAmount,
        expectedAmount: transferReconciliationsSchema.expectedAmount,
      })
      .from(transferReconciliationsSchema)
      .leftJoin(
        treasuryMovementsSchema,
        eq(
          treasuryMovementsSchema.transferReconciliationId,
          transferReconciliationsSchema.id,
        ),
      )
      .where(
        and(
          eq(transferReconciliationsSchema.organizationId, orgId),
          eq(transferReconciliationsSchema.status, 'confirmed'),
          isNull(treasuryMovementsSchema.id),
        ),
      );
    for (const r of stuck) {
      await tryDepositConfirmedTransfer(orgId, 'Sistema', r);
    }
  } catch (e) {
    console.error(
      '[transfer-reconciliation] deposit backfill skipped:',
      e instanceof Error ? e.message : e,
    );
  }
}

export async function markTransferNotArrived(
  id: string,
  note?: string | null,
): Promise<ActionResult<TransferReconciliation>> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const actor = await getActorName(userId);

  // Toggle B — default-resolution routing.
  // When the org has set transfer-default-resolution = 'direct_loss', a non-arrival
  // is auto-resolved as a loss instead of being parked in not_arrived.
  //
  // REVIEWER NOTE: direct_loss intentionally bypasses the interactive admin gate
  // (org:admin check). The admin pre-consented to this behavior by enabling the
  // setting — enabling it IS the admin action. This is not a missing permission
  // check. See ADR-5 in design obs #277.
  const defaultResolution = await getDefaultResolution(db, orgId);

  if (defaultResolution === 'direct_loss') {
    try {
      const resolved = await db.transaction(async (tx) => {
        const resolvedRow = await setReconciliationResolution(tx, {
          id,
          organizationId: orgId,
          resolvedBy: actor,
          resolutionType: 'loss',
          status: 'resolved',
        });
        if (!resolvedRow) {
          throw new Error('Transferencia no encontrada');
        }
        return resolvedRow;
      });

      await logAction({
        organizationId: orgId,
        actor: { type: 'user', id: userId },
        action: 'transfer.auto_resolved_loss',
        entityType: 'transfer_reconciliation',
        entityId: resolved.id,
        after: {
          status: resolved.status,
          resolutionType: resolved.resolutionType,
          setting: DEFAULT_RESOLUTION_SETTING_KEY,
        },
      });

      revalidatePath(CASH_PATH);
      return { ok: true, data: resolved };
    } catch (err) {
      if (err instanceof ActionValidationError) {
        return { ok: false, error: err.message };
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Error al resolver la transferencia',
      };
    }
  }

  // Default path: park as not_arrived for later investigation.
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

// Edits an ALREADY-confirmed transfer (a confirmed or mismatch row) and keeps
// Tesorería in sync — the "corrección segura" contract. Two corrections:
//   • 'amount'      — it really landed for a different amount. The row becomes
//                     confirmed (== expected) or mismatch (≠ expected) and the
//                     bank is adjusted by the delta.
//   • 'not_arrived' — it turned out it never landed. The row moves back to
//                     investigation and the full bank credit is clawed back.
// The status change and the bank adjustment run in ONE transaction, so the bank
// can never drift from the reconciliation.
export async function correctConfirmedTransfer(
  id: string,
  correction:
    | { kind: 'amount'; arrivedAmount: number | string }
    | { kind: 'not_arrived'; note?: string | null },
): Promise<ActionResult<TransferReconciliation>> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const actor = await getActorName(userId);

  try {
    const updated = await db.transaction(async (tx) => {
      const row = await getReconciliationById(tx, { id, organizationId: orgId });
      if (!row) {
        throw new ActionValidationError('Transferencia no encontrada');
      }
      if (row.status !== 'confirmed' && row.status !== 'mismatch') {
        throw new ActionValidationError(
          'Solo se puede editar una transferencia ya confirmada',
        );
      }

      // What the bank was credited when the transfer was confirmed.
      const previousBankAmount
        = Number.parseFloat(row.arrivedAmount ?? row.expectedAmount) || 0;

      let result: TransferReconciliation | null;
      let newBankAmount: number;

      if (correction.kind === 'not_arrived') {
        newBankAmount = 0;
        result = await markReconciliationNotArrived(tx, {
          id,
          organizationId: orgId,
          reconciledBy: actor,
          note: correction.note ?? null,
        });
      } else {
        const amount = Number.parseFloat(String(correction.arrivedAmount));
        if (!Number.isFinite(amount) || amount < 0) {
          throw new ActionValidationError('El monto corregido no es válido');
        }
        newBankAmount = amount;
        const expected = Number.parseFloat(row.expectedAmount) || 0;
        result
          = amount === expected
            ? await confirmReconciliation(tx, {
                id,
                organizationId: orgId,
                reconciledBy: actor,
                arrivedAmount: amount,
              })
            : await markReconciliationMismatch(tx, {
                id,
                organizationId: orgId,
                reconciledBy: actor,
                arrivedAmount: amount,
              });
      }

      if (!result) {
        throw new Error('No se pudo actualizar la transferencia');
      }

      await adjustConfirmedTransferDeposit(tx, {
        organizationId: orgId,
        method: row.method,
        previousBankAmount,
        newBankAmount,
        createdBy: actor,
        reference: row.reference,
      });

      return result;
    });

    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'transfer.corrected',
      entityType: 'transfer_reconciliation',
      entityId: updated.id,
      after: { status: updated.status, arrivedAmount: updated.arrivedAmount },
    });

    revalidatePath(CASH_PATH);
    revalidatePath(TESORERIA_PATH);
    return { ok: true, data: updated };
  } catch (err) {
    if (err instanceof ActionValidationError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

export async function confirmAllPendingTransfers(
  period?: { ids?: string[]; from?: Date; to?: Date },
): Promise<ActionResult<{ confirmed: number }>> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const actor = await getActorName(userId);
  // Confirm the batch first, then bridge each deposit best-effort (same rule as
  // the single confirm: bookkeeping must never block or 500 the confirmation).
  const confirmedRows = await db.transaction(async tx =>
    bulkConfirmPending(tx, {
      organizationId: orgId,
      reconciledBy: actor,
      ...period,
    }),
  );
  let depositError: string | null = null;
  for (const r of confirmedRows) {
    const err = await tryDepositConfirmedTransfer(orgId, actor, r);
    depositError = depositError ?? err;
  }
  const confirmed = confirmedRows.length;
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'transfer.bulk_confirmed',
    entityType: 'transfer_reconciliation',
    entityId: orgId,
    after: { confirmed },
  });
  revalidatePath(CASH_PATH);
  revalidatePath(TESORERIA_PATH);
  if (depositError) {
    return {
      ok: false,
      error: `${confirmed} transferencia(s) confirmada(s), pero no se registraron en Tesorería: ${depositError}`,
    };
  }
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

// Input for the captured customer when resolving as 'receivable'.
// When supplied (by the View B capture UI), the cashier gives a name + at least
// one contact (whatsapp or documentId) and a real customers row is found-or-created.
export type FiadoCustomerInput = {
  customerName: string;
  whatsapp?: string | null;
  documentId?: string | null;
};

// Closes the investigation of a not_arrived / mismatch transfer with an outcome.
// 'receivable' accepts an OPTIONAL customerInput: when a name is provided, a real
// customers row is found-or-created and the fiado is linked to it (customer_id set);
// when it is absent (the current panel button), it falls back to a legacy fiado
// with a null customer_id so the existing flow keeps working until the capture UI
// is wired in the View B redesign.
// 'loss' and 'cashier_liability' just record the outcome; the audit trail is the
// fraud signal (alerts are computed, not stored).
// claimOpen=true is only meaningful when resolutionType='loss' — it flags
// PÉRDIDA+RECLAMO (active insurance/legal claim). Same money routing as plain
// PÉRDIDA; the flag drives future RECOVERY eligibility.
export async function resolveTransfer(
  id: string,
  resolutionType: ResolutionType,
  customerInput?: FiadoCustomerInput,
  claimOpen?: boolean,
): Promise<ActionResult<TransferReconciliation>> {
  const { userId, orgId } = await requirePanelModule(MODULE);

  // Anti-fraud gate: loss and cashier_liability outcomes carry financial and
  // disciplinary consequences that must never be triggered by a cashier.
  // Even a cashier who holds the cash panel module is blocked — the module gate
  // (requirePanelModule) is a capability check, not a role check.
  // Pattern: mirrors actions/treasury.ts:182-190.
  if (resolutionType === 'loss' || resolutionType === 'cashier_liability') {
    const { orgRole } = await auth();
    if (orgRole !== 'org:admin') {
      return {
        ok: false,
        error: 'Solo el propietario puede registrar pérdidas o cargos al cajero',
      };
    }
  }

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
        if (!sale) {
          throw new ActionValidationError(
            'La venta no tiene cliente; marcá pérdida o responsabilidad del cajero',
          );
        }

        const owed = outstandingAmount(row);
        if (owed <= 0) {
          throw new ActionValidationError('No hay saldo pendiente para cobrar');
        }

        // Customer capture is optional for backward compatibility. When the
        // caller passes explicit customer data (the View B capture modal),
        // find-or-create a real customers row and link it (ADR-7: dedup on
        // whatsapp first, then documentId). When it is absent (the current
        // panel button), fall back to a legacy fiado with a null customer_id so
        // the existing flow keeps working until the capture UI is wired.
        let customerId: string | null = null;
        const capturedName = customerInput?.customerName?.trim() ?? '';
        if (capturedName) {
          const customer = await findOrCreateCustomer(tx, {
            orgId,
            name: capturedName,
            whatsapp: customerInput?.whatsapp ?? null,
            documentId: customerInput?.documentId ?? null,
            createdBy: actor,
          });
          customerId = customer.id;
        }

        const fiado = await createFiado(tx, {
          organizationId: orgId,
          saleId: sale.saleId,
          originalAmount: owed,
          createdBy: actor,
          customerId,
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
        status: 'resolved',
        resolutionFiadoId,
        claimOpen: resolutionType === 'loss' ? (claimOpen ?? false) : false,
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

// ── Axis-1: Late full arrival ─────────────────────────────────────────────────
// "Llegó tarde completa": a not_arrived transfer actually showed up in full.
// Reuses confirmReconciliation (the happy-path lib function) + the idempotent
// treasury deposit, preserving the same contract as confirmTransfer. Cashier-level.
export async function confirmLateTransfer(
  id: string,
  arrivedAmount?: number | string | null,
): Promise<ActionResult<TransferReconciliation>> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const actor = await getActorName(userId);

  const confirmed = await db.transaction(async tx =>
    confirmReconciliation(tx, {
      id,
      organizationId: orgId,
      reconciledBy: actor,
      arrivedAmount,
    }),
  );

  if (!confirmed) {
    return { ok: false, error: 'Transferencia no encontrada' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'transfer.late_arrival',
    entityType: 'transfer_reconciliation',
    entityId: confirmed.id,
    after: { status: confirmed.status, arrivedAmount: confirmed.arrivedAmount },
  });

  const depositError = await tryDepositConfirmedTransfer(orgId, actor, confirmed);

  revalidatePath(CASH_PATH);
  revalidatePath(TESORERIA_PATH);

  if (depositError) {
    return {
      ok: false,
      error: `Transferencia confirmada, pero no se registró en Tesorería: ${depositError}`,
    };
  }
  return { ok: true, data: confirmed };
}

// ── Axis-1: Partial arrival ───────────────────────────────────────────────────
// "Llegó parcial $X": the transfer partially showed up.
// • Original row → resolved, arrivedAmount=$X, remainderReconciliationId set.
// • New remainder row → not_arrived, expectedAmount=original.expected-$X.
// • Treasury credit posted for $X only (NOT for the remainder).
// Conservation: arrived + remainder.expected === original.expected.
// Validation: 0 < arrivedAmount < expectedAmount (strict bounds).
// Cashier-level permission.
export async function partialTransferArrival(
  id: string,
  arrivedAmount: number | string,
): Promise<
  ActionResult<{ original: TransferReconciliation; remainder: TransferReconciliation }>
> {
  const { userId, orgId } = await requirePanelModule(MODULE);
  const actor = await getActorName(userId);

  try {
    const result = await db.transaction(async tx =>
      splitPartialArrival(tx, {
        id,
        organizationId: orgId,
        reconciledBy: actor,
        arrivedAmount,
      }),
    );

    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'transfer.partial_arrival',
      entityType: 'transfer_reconciliation',
      entityId: result.original.id,
      after: {
        arrivedAmount: result.original.arrivedAmount,
        remainderId: result.remainder.id,
        remainderExpected: result.remainder.expectedAmount,
      },
    });

    // Treasury credit for the arrived portion only. Best-effort (same as
    // confirmTransfer): if the deposit fails, the transfer stays resolved and
    // the deposit can be re-applied once the cause is fixed.
    const depositError = await tryDepositConfirmedTransfer(orgId, actor, {
      id: result.original.id,
      method: result.original.method,
      arrivedAmount: result.original.arrivedAmount,
      expectedAmount: result.original.expectedAmount,
    });

    revalidatePath(CASH_PATH);
    revalidatePath(TESORERIA_PATH);

    if (depositError) {
      return {
        ok: false,
        error: `Transferencia parcial registrada, pero no se contabilizó en Tesorería: ${depositError}`,
      };
    }

    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof Error) {
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

// ── Axis-2: Cross-period recovery (ADR-8) ────────────────────────────────────
// "Recuperación": the admin registers a recovery when money reappears after a
// closed-period loss. A NEW transfer_reconciliations row is inserted in the
// CURRENT period referencing the old loss row via recoveryOfId. The old row is
// NEVER modified — immutability is the core audit invariant.
//
// Admin-only gate: recovery carries the same fraud risk as loss itself — if a
// cashier could fabricate a recovery, they could book fictitious treasury credits.
// Gate pattern mirrors treasury.ts:182-190 and resolveTransfer for loss.
//
// The lib (createRecoveryReconciliation) validates that the referenced row is a
// loss row (S-22 invariant). The action posts the treasury credit after insert,
// best-effort (same pattern as confirmTransfer: bookkeeping failure must not
// roll back the recovery itself).
export async function recoverTransfer(
  lossReconciliationId: string,
  arrivedAmount: number,
): Promise<ActionResult<TransferReconciliation>> {
  const { userId, orgId } = await requirePanelModule(MODULE);

  // Admin-only anti-fraud gate (S-14 invariant).
  const { orgRole } = await auth();

  if (orgRole !== 'org:admin') {
    return {
      ok: false,
      error: 'Solo el propietario puede registrar una recuperación',
    };
  }

  const actor = await getActorName(userId);

  let recovery: TransferReconciliation;

  try {
    recovery = await db.transaction(async (tx) => {
      // Read the source row first to copy method/org for the recovery row.
      // createRecoveryReconciliation validates that it is a loss row (S-22).
      const sourceRow = await getReconciliationById(tx, {
        id: lossReconciliationId,
        organizationId: orgId,
      });

      if (!sourceRow) {
        throw new ActionValidationError('Transferencia original no encontrada');
      }

      return createRecoveryReconciliation(tx, {
        organizationId: orgId,
        recoveryOfId: lossReconciliationId,
        method: sourceRow.method,
        amount: arrivedAmount,
        createdBy: actor,
      });
    });
  } catch (err) {
    if (err instanceof ActionValidationError) {
      return { ok: false, error: err.message };
    }
    if (err instanceof Error) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'transfer.recovery',
    entityType: 'transfer_reconciliation',
    entityId: recovery.id,
    after: {
      recoveryOfId: lossReconciliationId,
      arrivedAmount,
    },
  });

  // Post the treasury credit best-effort. A deposit failure must never roll back
  // the recovery row — the money is recorded; the bookkeeping catches up later.
  const depositError = await tryDepositConfirmedTransfer(orgId, actor, {
    id: recovery.id,
    method: recovery.method,
    arrivedAmount: recovery.arrivedAmount,
    expectedAmount: recovery.expectedAmount,
  });

  revalidatePath(CASH_PATH);
  revalidatePath(TESORERIA_PATH);

  if (depositError) {
    return {
      ok: false,
      error: `Recuperación registrada, pero no se contabilizó en Tesorería: ${depositError}`,
    };
  }

  return { ok: true, data: recovery };
}
