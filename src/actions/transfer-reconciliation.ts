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
import { createCredito } from '@/libs/creditos';
import { findOrCreateCustomer } from '@/libs/customers';
import { db } from '@/libs/DB';
import { requirePanelModule } from '@/libs/panel-session';
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
  markReconciliationNotArrived,
  outstandingAmount,
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

// Statuses an investigation/arrival action may act on. `confirmed` and
// `resolved` are terminal for these paths: re-resolving or re-confirming one
// would silently re-mutate a row the owner already closed (a replay) or flip a
// confirmed row to a loss WITHOUT clawing back its bank deposit. Those must go
// through correctConfirmedTransfer / recoverTransfer instead.
const INVESTIGABLE_STATUSES: ReconciliationStatus[] = ['not_arrived', 'mismatch'];

function isInvestigable(status: ReconciliationStatus): boolean {
  return INVESTIGABLE_STATUSES.includes(status);
}
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

// ── Verification-time entry: "Novedad" ────────────────────────────────────────
// The cashier verifying a pending transfer has exactly two choices: Confirmar
// (the amount matches) or Novedad (something is off → enter what REALLY arrived).
// This single entry routes that amount server-side, so the more/less/zero rule
// never lives in the client:
//   • arrived >= expected → confirm at the real amount. A surplus just deposits
//     the real figure; there is nothing to investigate ("no pasa nada").
//   • 0 < arrived < expected → partial: the arrived portion confirms and
//     deposits; the shortfall is routed by the org's default-resolution setting
//     (investigate → opens a case; direct_loss → closes as a loss).
//   • arrived === 0 → nothing landed (the former "No llegó"): routed by that same
//     default-resolution setting.
// Only a still-pending row is a valid Novedad target.
export async function recordTransferNovelty(
  id: string,
  arrivedAmount: number | string,
): Promise<ActionResult<TransferReconciliation>> {
  const { orgId } = await requirePanelModule(MODULE);

  const row = await getReconciliationById(db, { id, organizationId: orgId });
  if (!row) {
    return { ok: false, error: 'Transferencia no encontrada' };
  }
  if (row.status !== 'pending') {
    return {
      ok: false,
      error: 'Solo una transferencia por verificar admite una novedad',
    };
  }

  const arrived = Number.parseFloat(String(arrivedAmount));
  if (!Number.isFinite(arrived) || arrived < 0) {
    return { ok: false, error: 'Ingresá un monto válido (0 o mayor).' };
  }

  const expected = Number.parseFloat(row.expectedAmount) || 0;

  // Nothing landed → not-arrived routing (respects default-resolution).
  if (arrived === 0) {
    return markTransferNotArrived(id);
  }
  // Short → partial: confirm what arrived, route the shortfall by the setting.
  if (arrived < expected) {
    const result = await partialTransferArrival(id, arrived);
    return result.ok ? { ok: true, data: result.data.original } : result;
  }
  // Exact or surplus → confirm at the real amount.
  return confirmTransfer(id, arrived);
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
        // Guard: only a still-pending transfer can be auto-resolved to loss.
        // Without this, a replayed or non-UI call could flip a confirmed
        // (already deposited) row to loss with no bank clawback — the same harm
        // the resolve-path status guard prevents (see isInvestigable).
        const current = await getReconciliationById(tx, {
          id,
          organizationId: orgId,
        });
        if (!current) {
          throw new ActionValidationError('Transferencia no encontrada');
        }
        if (current.status !== 'pending') {
          throw new ActionValidationError(
            'Solo una transferencia pendiente puede resolverse como pérdida automática',
          );
        }
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

// Corrects an ALREADY-confirmed transfer (a confirmed or mismatch row). The
// amount is IMMUTABLE: what arrived is what should have arrived — editing it
// would desync the reconciliation from the sale that recorded the payment. The
// ONLY correction is reversal: it turned out the transfer never landed, so the
// row moves back to investigation and the full bank credit is clawed back. The
// status change and the bank claw-back run in ONE transaction, so the bank can
// never drift from the reconciliation.
export async function correctConfirmedTransfer(
  id: string,
  correction?: { note?: string | null },
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
          'Solo se puede corregir una transferencia ya confirmada',
        );
      }

      // What the bank was credited when the transfer was confirmed — clawed
      // back in full since the money never actually arrived.
      const previousBankAmount
        = Number.parseFloat(row.arrivedAmount ?? row.expectedAmount) || 0;

      const result = await markReconciliationNotArrived(tx, {
        id,
        organizationId: orgId,
        reconciledBy: actor,
        note: correction?.note ?? null,
      });

      if (!result) {
        throw new Error('No se pudo actualizar la transferencia');
      }

      await adjustConfirmedTransferDeposit(tx, {
        organizationId: orgId,
        method: row.method,
        previousBankAmount,
        newBankAmount: 0,
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

// Input for the captured customer when resolving as 'receivable'.
// When supplied (by the View B capture UI), the cashier gives a name + at least
// one contact (whatsapp or documentId) and a real customers row is found-or-created.
export type CreditoCustomerInput = {
  customerName: string;
  whatsapp?: string | null;
  documentId?: string | null;
};

// Closes the investigation of a not_arrived / mismatch transfer with an outcome.
// 'receivable' accepts an OPTIONAL customerInput: when a name is provided, a real
// customers row is found-or-created and the credito is linked to it (customer_id set);
// when it is absent (the current panel button), it falls back to a legacy credito
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
  customerInput?: CreditoCustomerInput,
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
      if (!isInvestigable(row.status)) {
        throw new ActionValidationError(
          row.status === 'resolved'
            ? 'Esta transferencia ya fue resuelta'
            : 'Solo se puede resolver una transferencia en investigación; usá la corrección para una transferencia confirmada',
        );
      }

      let resolutionCreditoId: string | null = null;
      if (resolutionType === 'receivable') {
        if (!row.salePaymentId) {
          throw new ActionValidationError(
            'Solo una venta con cliente puede pasar a crédito',
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
        // panel button), fall back to a legacy credito with a null customer_id so
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

        const credito = await createCredito(tx, {
          organizationId: orgId,
          saleId: sale.saleId,
          originalAmount: owed,
          createdBy: actor,
          customerId,
          notes: sale.notes,
        });
        if (!credito) {
          throw new ActionValidationError('No se pudo crear el crédito');
        }
        resolutionCreditoId = credito.id;
      }

      const updated = await setReconciliationResolution(tx, {
        id,
        organizationId: orgId,
        resolutionType,
        resolvedBy: actor,
        status: 'resolved',
        resolutionCreditoId,
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
        resolutionCreditoId: resolved.resolutionCreditoId,
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

  let confirmed: TransferReconciliation | null;
  try {
    confirmed = await db.transaction(async (tx) => {
      // Current-status guard: a late arrival only makes sense for a row still
      // under investigation. Re-confirming a `confirmed` row (replay) or a
      // terminal `resolved` row would silently re-mutate it.
      const row = await getReconciliationById(tx, { id, organizationId: orgId });
      if (!row) {
        throw new ActionValidationError('Transferencia no encontrada');
      }
      if (!isInvestigable(row.status)) {
        throw new ActionValidationError(
          row.status === 'confirmed'
            ? 'Esta transferencia ya fue confirmada'
            : 'Solo se puede confirmar la llegada de una transferencia en investigación',
        );
      }
      return confirmReconciliation(tx, {
        id,
        organizationId: orgId,
        reconciledBy: actor,
        arrivedAmount,
      });
    });
  } catch (err) {
    if (err instanceof ActionValidationError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

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
// • New remainder row → expectedAmount=original.expected-$X. Its fate follows the
//   org's default-resolution setting: 'investigate' (default) parks it as
//   not_arrived for a case; 'direct_loss' closes it as a loss immediately —
//   exactly like a full non-arrival, so the shortfall never sits in limbo when
//   the org opted out of investigations.
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

  // Read the shortfall routing setting once, outside the tx (it reads
  // app_settings). 'direct_loss' closes the remainder as a loss in the same tx;
  // 'investigate' (default) leaves it parked as not_arrived for a case.
  const defaultResolution = await getDefaultResolution(db, orgId);

  try {
    // The split AND its treasury credit run in ONE transaction. The arrived row
    // ends `resolved`, which backfillConfirmedTransferDeposits does NOT retry
    // (it only covers `confirmed` rows). A best-effort post-commit deposit could
    // therefore be silently dropped, losing the arrived $X from Tesorería. Posting
    // the deposit inside the split tx makes it atomic: if the deposit fails, the
    // whole split rolls back so the cashier simply retries — the money is durable.
    const result = await db.transaction(async (tx) => {
      const split = await splitPartialArrival(tx, {
        id,
        organizationId: orgId,
        reconciledBy: actor,
        arrivedAmount,
      });
      // Treasury credit for the arrived portion only (keyed by the row id, which
      // is idempotent via the unique index on transfer_reconciliation_id).
      await depositConfirmedTransfer(tx, {
        organizationId: orgId,
        reconciliationId: split.original.id,
        method: split.original.method,
        amount: split.original.arrivedAmount ?? split.original.expectedAmount,
        createdBy: actor,
      });
      // Route the shortfall by the org setting. direct_loss closes the remainder
      // now (no bank credit was posted for it, so nothing to claw back); the
      // default leaves it not_arrived for the investigation flow.
      if (defaultResolution === 'direct_loss') {
        const resolvedRemainder = await setReconciliationResolution(tx, {
          id: split.remainder.id,
          organizationId: orgId,
          resolvedBy: actor,
          resolutionType: 'loss',
          status: 'resolved',
        });
        if (resolvedRemainder) {
          return { original: split.original, remainder: resolvedRemainder };
        }
      }
      return split;
    });

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

    revalidatePath(CASH_PATH);
    revalidatePath(TESORERIA_PATH);

    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof Error) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
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
