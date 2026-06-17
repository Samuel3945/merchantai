'use server';

import type { ActionResult } from '@/libs/action-result';
import { auth, currentUser } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { findOpenSession, toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { requirePanelModule } from '@/libs/panel-session';
import {
  getHandoverStatusForSessions,
  getOrCreatePendingAccount,
  getRemainingForHandover,
  recordBankConsignacion,
  recordContainerTransfer,
  recordGastoOutflow,
  recordHandoverReturnToCaja,
} from '@/libs/treasury';
import {
  posTokensSchema,
  treasuryAccountsSchema,
  treasuryMovementsSchema,
} from '@/models/Schema';

/**
 * Owner-only (org:admin) gate. Mirrors requireAdminContext in pos-tokens.ts.
 * reclassifyAutoSweep is owner-callable per the design's owner-only requirement.
 */
async function requireOwnerContext(): Promise<{ userId: string; orgId: string }> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole !== 'org:admin') {
    throw new Error('Only organization owners can reclassify auto-sweep transfers');
  }
  return { userId, orgId };
}

const TESORERIA_PATH = '/dashboard/tesoreria';
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

/**
 * Places money from the org's Pendiente de ubicar (transito) account to a
 * banco account. Reuses recordBankConsignacion which already enforces the
 * per-account balance guard. The placement is tagged with the originating
 * handover movement id so per-handover attribution is preserved.
 *
 * Gated by requirePanelModule('cash') — owner always passes.
 */
export async function placeHandoverToBanco(
  handoverMovementId: string,
  toBankAccountId: string,
  amount: number | string,
): Promise<ActionResult<null>> {
  const { userId, orgId } = await requirePanelModule('cash');

  if (!handoverMovementId) {
    return { ok: false, error: 'handoverMovementId es requerido' };
  }
  if (!toBankAccountId) {
    return { ok: false, error: 'Cuenta bancaria de destino es requerida' };
  }
  const amt = toMoney(amount);
  if (Number.parseFloat(amt) <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }

  const actor = await getActorName(userId);

  try {
    await db.transaction(async (tx) => {
      const pending = await getOrCreatePendingAccount(tx, orgId, actor);
      await recordBankConsignacion(tx, {
        organizationId: orgId,
        fromAccountId: pending.id,
        toBankAccountId,
        amount: amt,
        createdBy: actor,
        handoverMovementId,
      });
    });
    revalidatePath(TESORERIA_PATH);
    revalidatePath(CASH_PATH);
    return { ok: true, data: null };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al ubicar en banco',
    };
  }
}

/**
 * Places money from the org's Pendiente de ubicar (transito) account to a
 * caja fuerte container. Reuses recordContainerTransfer (balance guard included).
 *
 * Gated by requirePanelModule('cash') — owner always passes.
 */
export async function placeHandoverToCajaFuerte(
  handoverMovementId: string,
  toCajaFuerteAccountId: string,
  amount: number | string,
): Promise<ActionResult<null>> {
  const { userId, orgId } = await requirePanelModule('cash');

  if (!handoverMovementId) {
    return { ok: false, error: 'handoverMovementId es requerido' };
  }
  if (!toCajaFuerteAccountId) {
    return { ok: false, error: 'Caja fuerte de destino es requerida' };
  }
  const amt = toMoney(amount);
  if (Number.parseFloat(amt) <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }

  const actor = await getActorName(userId);

  try {
    await db.transaction(async (tx) => {
      const pending = await getOrCreatePendingAccount(tx, orgId, actor);
      await recordContainerTransfer(tx, {
        organizationId: orgId,
        fromAccountId: pending.id,
        toAccountId: toCajaFuerteAccountId,
        amount: amt,
        createdBy: actor,
        handoverMovementId,
      });
    });
    revalidatePath(TESORERIA_PATH);
    revalidatePath(CASH_PATH);
    return { ok: true, data: null };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al ubicar en caja fuerte',
    };
  }
}

/**
 * Places money from the org's Pendiente de ubicar (transito) account as a
 * gasto (expense, out-of-treasury). Reuses recordGastoOutflow (balance guard
 * included). Category defaults to 'tesoreria' for placement-origin gastos.
 *
 * Gated by requirePanelModule('cash') — owner always passes.
 */
export async function placeHandoverAsGasto(
  handoverMovementId: string,
  amount: number | string,
  description?: string | null,
): Promise<ActionResult<null>> {
  const { userId, orgId } = await requirePanelModule('cash');

  if (!handoverMovementId) {
    return { ok: false, error: 'handoverMovementId es requerido' };
  }
  const amt = toMoney(amount);
  if (Number.parseFloat(amt) <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }

  const actor = await getActorName(userId);

  try {
    await db.transaction(async (tx) => {
      const pending = await getOrCreatePendingAccount(tx, orgId, actor);
      await recordGastoOutflow(tx, {
        organizationId: orgId,
        fromAccountId: pending.id,
        amount: amt,
        category: 'tesoreria',
        description: description ?? null,
        incurredOn: new Date().toISOString().slice(0, 10),
        createdBy: actor,
        handoverMovementId,
      });
    });
    revalidatePath(TESORERIA_PATH);
    revalidatePath(CASH_PATH);
    return { ok: true, data: null };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al registrar como gasto',
    };
  }
}

/**
 * Returns count and total outstanding Pendiente balance for the dashboard badge.
 * Gated by requirePanelModule('cash').
 */
export async function getPendingHandoversOverview(): Promise<
  ActionResult<{ count: number; total: number }>
> {
  const { orgId } = await requirePanelModule('cash');
  const { countPendingHandovers } = await import('@/libs/treasury');
  const overview = await countPendingHandovers(db, orgId);
  return { ok: true, data: overview };
}

/**
 * Returns the list of pending handovers with remaining balances.
 * Used by the AllocateModal placement queue.
 * Gated by requirePanelModule('cash').
 */
export async function listPendingHandoversAction(): Promise<
  ActionResult<import('@/libs/treasury').PendingHandover[]>
> {
  const { orgId } = await requirePanelModule('cash');
  const { listPendingHandovers } = await import('@/libs/treasury');
  const handovers = await listPendingHandovers(db, orgId);
  return { ok: true, data: handovers };
}

/**
 * For each session ID in the input array, returns whether a handover movement
 * row exists for that session (R7 — "entregado" label on caja cards).
 * Returns a plain object { [sessionId]: boolean } (serializable from server action).
 * Non-fatal: returns empty object on error.
 * Gated by requirePanelModule('cash').
 */
export async function getHandoverStatusForSessionsAction(
  sessionIds: string[],
): Promise<ActionResult<Record<string, boolean>>> {
  if (sessionIds.length === 0) {
    return { ok: true, data: {} };
  }
  const { orgId } = await requirePanelModule('cash');
  const statusMap = await getHandoverStatusForSessions(db, orgId, sessionIds);
  const result: Record<string, boolean> = {};
  for (const [id, v] of statusMap) {
    result[id] = v;
  }
  return { ok: true, data: result };
}

/**
 * Reclassifies an auto-routed sweep transfer to a new cofre destination.
 * Owner-only (gated by requirePanelModule('cash')).
 *
 * The original transfer (transito → cofre A) is compensated by a reverse
 * transfer (cofre A → transito), restoring the transito balance.
 * A new forward transfer (transito → cofre B) is then recorded with the same
 * handoverMovementId so per-handover remaining stays at 0.
 *
 * All three movements are written inside one transaction (ADR-5 immutability
 * + compensating-entries philosophy). The original rows are never mutated.
 */
export async function reclassifyAutoSweep(
  originalTransferId: string,
  newDestinationAccountId: string,
): Promise<ActionResult<{ ok: true }>> {
  const { userId, orgId } = await requireOwnerContext();

  if (!originalTransferId || !newDestinationAccountId) {
    return { ok: false, error: 'originalTransferId and newDestinationAccountId are required' };
  }

  // F1: cofre-only guard — newDestinationAccountId must be an ACTIVE caja_fuerte
  // owned by this org. Mirrors the validation in setPosTokenSweepDestination.
  const [destAccount] = await db
    .select({
      id: treasuryAccountsSchema.id,
      type: treasuryAccountsSchema.type,
      active: treasuryAccountsSchema.active,
    })
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.id, newDestinationAccountId),
        eq(treasuryAccountsSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!destAccount) {
    return { ok: false, error: 'Cuenta de destino no encontrada' };
  }
  if (!destAccount.active) {
    return { ok: false, error: 'La cuenta de destino está inactiva' };
  }
  if (destAccount.type !== 'caja_fuerte') {
    return {
      ok: false,
      error: 'Solo las cajas fuertes (cofres) pueden ser destino del traspaso automático',
    };
  }

  const actor = await getActorName(userId);

  try {
    await db.transaction(async (tx) => {
      // Load the original transfer to validate it belongs to this org
      const [original] = await tx
        .select({
          id: treasuryMovementsSchema.id,
          fromAccountId: treasuryMovementsSchema.fromAccountId,
          toAccountId: treasuryMovementsSchema.toAccountId,
          amount: treasuryMovementsSchema.amount,
          handoverMovementId: treasuryMovementsSchema.handoverMovementId,
          organizationId: treasuryMovementsSchema.organizationId,
        })
        .from(treasuryMovementsSchema)
        .where(eq(treasuryMovementsSchema.id, originalTransferId))
        .limit(1);

      if (!original || original.organizationId !== orgId) {
        throw new Error('Movimiento no encontrado o no pertenece a la organización');
      }
      if (original.handoverMovementId == null) {
        throw new Error('El movimiento no es un traspaso auto-dirigido (handover_movement_id nulo)');
      }
      // handoverMovementId is validated above (non-null) but intentionally not
      // forwarded to the compensating transfers: the original placement already
      // consumed it (remaining=0). Forwarding it would incorrectly re-open the
      // per-handover remaining and break the placement-queue invariant.
      const amount = original.amount;
      const transitoId = original.fromAccountId;
      const oldCofreId = original.toAccountId;

      if (!transitoId || !oldCofreId) {
        throw new Error('El movimiento original no tiene origen o destino válido');
      }

      const amtNum = Number.parseFloat(String(amount));

      // Step 1: reverse the original placement (cofre A → transito).
      // No handoverMovementId — this is a compensating ledger entry, not a placement.
      await recordContainerTransfer(tx, {
        organizationId: orgId,
        fromAccountId: oldCofreId,
        toAccountId: transitoId,
        amount: String(amtNum),
        createdBy: actor,
        reason: 'Reclasificación de traspaso automático',
      });

      // Step 2: place to the new destination (transito → cofre B).
      // No handoverMovementId — the original handover is already fully-placed (remaining=0).
      // The "entregado" label is based on the original placement row (which still exists).
      await recordContainerTransfer(tx, {
        organizationId: orgId,
        fromAccountId: transitoId,
        toAccountId: newDestinationAccountId,
        amount: String(amtNum),
        createdBy: actor,
        reason: 'Reclasificación de traspaso automático',
      });
    });

    revalidatePath(TESORERIA_PATH);
    revalidatePath(CASH_PATH);
    return { ok: true, data: { ok: true } };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al reclasificar el traspaso',
    };
  }
}

/**
 * Places money from the org's Pendiente de ubicar (transito) account back to a
 * POS caja that must be OPEN at call time.
 *
 * Money-conservation invariant:
 *   transito −amount (salida)  →  cash_movements entrada on the open session
 *   Total treasury balance stays flat: we debit transito and credit the caja.
 *
 * Gated by requirePanelModule('cash') — consistent with the sibling placeHandoverTo* actions.
 *
 * @param handoverMovementId - the treasury_movements row id (type='handover')
 * @param targetPosTokenId   - pos_tokens.id of the caja to receive cash
 * @param amount             - amount to place (partial placement supported)
 */
export async function placeHandoverToCaja(
  handoverMovementId: string,
  targetPosTokenId: string,
  amount: number | string,
): Promise<ActionResult<null>> {
  const { userId, orgId } = await requirePanelModule('cash');

  if (!handoverMovementId) {
    return { ok: false, error: 'handoverMovementId es requerido' };
  }
  if (!targetPosTokenId) {
    return { ok: false, error: 'Caja de destino es requerida' };
  }
  const amt = toMoney(amount);
  if (Number.parseFloat(amt) <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }

  const actor = await getActorName(userId);

  try {
    await db.transaction(async (tx) => {
      // 1. Validate target pos_token belongs to this org.
      const [token] = await tx
        .select({ id: posTokensSchema.id, deviceName: posTokensSchema.deviceName })
        .from(posTokensSchema)
        .where(
          and(
            eq(posTokensSchema.id, targetPosTokenId),
            eq(posTokensSchema.organizationId, orgId),
          ),
        )
        .limit(1);

      if (!token) {
        throw new Error('La caja seleccionada no existe o no pertenece a la organización');
      }

      // 2. Validate the target has an OPEN cash_session — money can only flow
      //    into a caja that is actively handling transactions.
      const openSession = await findOpenSession(tx, orgId, targetPosTokenId);
      if (!openSession) {
        throw new Error(
          `La caja debe estar abierta para recibir el dinero. `
          + `Abrí "${token.deviceName}" primero.`,
        );
      }

      // 3. Guard: remaining on the handover must cover the requested amount.
      const remaining = await getRemainingForHandover(tx, handoverMovementId, orgId);
      if (remaining < Number.parseFloat(amt)) {
        throw new Error(
          `El monto supera el saldo disponible en este handover `
          + `(disponible: ${remaining.toFixed(2)}, solicitado: ${Number.parseFloat(amt).toFixed(2)})`,
        );
      }

      // 4 + 5. Debit transito + credit the open caja session atomically.
      //        recordHandoverReturnToCaja encapsulates the two-row write:
      //        treasury salida (Pendiente → null) + cash_movements deposit (internal origin).
      const pending = await getOrCreatePendingAccount(tx, orgId, actor);
      await recordHandoverReturnToCaja(tx, {
        organizationId: orgId,
        handoverMovementId,
        pendingAccountId: pending.id,
        openSessionId: openSession.id,
        deviceName: token.deviceName,
        amount: amt,
        createdBy: actor,
      });
    });

    revalidatePath(TESORERIA_PATH);
    revalidatePath(CASH_PATH);
    return { ok: true, data: null };
  } catch (err: unknown) {
    // Surface descriptive errors (open-session guard, remaining guard) as
    // user-facing messages instead of 500s.
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Error al ubicar en caja',
    };
  }
}
