import type { db } from '@/libs/DB';
import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  computeCashBreakdown,
  findOpenSession,
  getOpeningExpected,
  toMoney,
} from '@/libs/cash-helpers';
import {
  cajasSchema,
  cashMovementsSchema,
  cashSessionsSchema,
  expensesSchema,
  paymentMethodsSchema,
  posTokensSchema,
  supplierPayablesSchema,
  supplierPaymentsSchema,
  transferReconciliationsSchema,
  treasuryAccountsSchema,
  treasuryMovementsSchema,
  treasuryTransfersSchema,
} from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TreasuryAccountType = 'caja' | 'caja_fuerte' | 'banco' | 'transito';

export type TreasuryAccount = {
  key: string;
  /**
   * The real treasury_accounts.id — present only for ledger-backed containers
   * (caja_fuerte / banco / transito). Absent for POS cajas, which are virtual
   * (derived from cash_sessions). Transfers MUST use this id, never `key`
   * (the display key embeds a name for banco, e.g. "banco:Nequi").
   */
  accountId?: string;
  name: string;
  type: TreasuryAccountType;
  balance: number;
  note?: string;
  /**
   * For type='caja' only: the ID of the last closed cash session for this drawer.
   * Used by the caja card to look up whether the session had a handover
   * (R7 "entregado" label). Absent when there is no closed session for the drawer.
   */
  sessionId?: string;
};

// A drawer's current cash: the open session's expected, or — if closed — the
// last close count (the last known physical amount). Phase 1 reads existing
// data; carrying the balance forward natively is Phase 3.
async function cajaBalance(
  executor: Executor,
  organizationId: string,
  posTokenId: string | null,
): Promise<number> {
  const open = await findOpenSession(executor, organizationId, posTokenId);
  if (open) {
    const { expected } = await computeCashBreakdown(executor, open);
    return expected;
  }
  // No open session: fall back to the last close count (carry-over).
  // When posTokenId is null (admin/legacy session), query manually because
  // getOpeningExpected only handles device sessions (non-null posTokenId).
  if (posTokenId === null) {
    const [last] = await executor
      .select({ counted: cashSessionsSchema.countedAmount })
      .from(cashSessionsSchema)
      .where(
        and(
          eq(cashSessionsSchema.organizationId, organizationId),
          isNull(cashSessionsSchema.posTokenId),
          eq(cashSessionsSchema.status, 'closed'),
        ),
      )
      .orderBy(desc(cashSessionsSchema.closedAt))
      .limit(1);
    return last ? Number.parseFloat(last.counted ?? '0') || 0 : 0;
  }
  const { expected } = await getOpeningExpected(executor, organizationId, posTokenId);
  return expected;
}

// Phase 2C treasury position — CUTOVER.
// Cajas (POS drawers): unchanged — still derive from cash_sessions + cash_movements
//   via cajaBalance() (Phase 1 path). Hot sales path not touched.
// Caja fuerte + banco: NOW read from the treasury_accounts ledger.
//   balance = opening_balance + Σ(treasury_movements to=id) − Σ(from=id)
//   The old SUM(cash_movements.withdrawal) and SUM(treasury_transfers) derivations
//   are DELETED here — this is the atomic cutover. No feature flag, no dual-read.
export async function getTreasuryPosition(
  executor: Executor,
  organizationId: string,
): Promise<TreasuryAccount[]> {
  const accounts: TreasuryAccount[] = [];

  // Cajas POS — one drawer per ACTIVE device. Deactivated devices (active=false)
  // must be hidden here exactly like the cajas panel (which filters active).
  // Migration 0076 deactivates the phantom 'ai_agent' pos_tokens on the premise
  // that "the panel only lists active devices" — but this view never honored
  // active, so those phantoms resurfaced as $0 "cajas" in "Dónde está la plata".
  const tokens = await executor
    .select({
      id: posTokensSchema.id,
      name: posTokensSchema.deviceName,
      cajaId: posTokensSchema.cajaId,
      cajaName: cajasSchema.name,
    })
    .from(posTokensSchema)
    .leftJoin(cajasSchema, eq(posTokensSchema.cajaId, cajasSchema.id))
    .where(
      and(
        eq(posTokensSchema.organizationId, organizationId),
        eq(posTokensSchema.active, true),
      ),
    );

  // El dinero vive en la BOLSA (caja), no en el dispositivo: varios dispositivos
  // que comparten una caja resuelven a la MISMA sesión, así que emitimos UN solo
  // lugar por caja (si no, el efectivo compartido se contaría doble). Dispositivos
  // sin caja (legacy) caen a "una caja por dispositivo".
  type CajaGroup = {
    key: string;
    name: string;
    repTokenId: string;
    cajaId: string | null;
  };
  const cajaGroups: CajaGroup[] = [];
  const seenCaja = new Set<string>();
  for (const t of tokens) {
    if (t.cajaId) {
      if (seenCaja.has(t.cajaId)) {
        continue;
      }
      seenCaja.add(t.cajaId);
      cajaGroups.push({
        key: `caja:${t.cajaId}`,
        name: t.cajaName ?? t.name,
        repTokenId: t.id,
        cajaId: t.cajaId,
      });
    } else {
      cajaGroups.push({
        key: `caja:${t.id}`,
        name: t.name,
        repTokenId: t.id,
        cajaId: null,
      });
    }
  }

  // Última sesión cerrada por CAJA (para el label R7 "entregado"). Con cajas
  // compartidas la sesión cuelga de caja_id; para dispositivos sin caja usamos
  // pos_token_id. Map key = cajaId ?? posTokenId.
  const lastSessionIds = new Map<string, string>();
  if (cajaGroups.length > 0) {
    const byCaja = await executor
      .select({
        cajaId: sql<string>`caja_id::text`,
        sessionId: sql<string>`id::text`,
      })
      .from(
        sql`(
          SELECT DISTINCT ON (caja_id)
            id, caja_id
          FROM cash_sessions
          WHERE organization_id = ${organizationId}
            AND status = 'closed'
            AND caja_id IS NOT NULL
          ORDER BY caja_id, closed_at DESC
        ) latest_by_caja`,
      );
    for (const r of byCaja) {
      lastSessionIds.set(r.cajaId, r.sessionId);
    }
    const byToken = await executor
      .select({
        posTokenId: sql<string>`pos_token_id::text`,
        sessionId: sql<string>`id::text`,
      })
      .from(
        sql`(
          SELECT DISTINCT ON (pos_token_id)
            id, pos_token_id
          FROM cash_sessions
          WHERE organization_id = ${organizationId}
            AND status = 'closed'
            AND caja_id IS NULL
            AND pos_token_id IS NOT NULL
          ORDER BY pos_token_id, closed_at DESC
        ) latest_by_token`,
      );
    for (const r of byToken) {
      lastSessionIds.set(r.posTokenId, r.sessionId);
    }
  }

  // treasury-sweep-model slice 1 — the handoverBySession subtraction here has
  // been retired. Double-count prevention is now handled by two paths:
  //   1. getOpeningExpected already subtracts handover rows from the carryover base
  //      (for the closed-caja path in cajaBalance), so the raw balance is already
  //      the post-handover expectation.
  //   2. For open sessions, computeCashBreakdown returns the physical opening amount
  //      (what the cashier counted), which is the actual in-drawer balance.
  // In both paths, cajaBalance() returns the correct net balance without any
  // additional subtraction. The transito account independently accumulates the
  // swept amount. No further correction is needed here. ADR-1 sub-decision.

  const cajas = await Promise.all(
    cajaGroups.map(async (g) => {
      // Un representante del grupo basta: comparten la sesión de la caja, así que
      // cajaBalance() devuelve el saldo de la bolsa UNA vez.
      const balance = await cajaBalance(executor, organizationId, g.repTokenId);
      const sessionId = lastSessionIds.get(g.cajaId ?? g.repTokenId);
      return {
        key: g.key,
        name: g.name,
        type: 'caja' as const,
        balance,
        sessionId,
      };
    }),
  );
  accounts.push(...cajas);

  // Vault (caja_fuerte) + banco accounts — READ FROM LEDGER (Phase 2C cutover).
  // Fetch all non-caja treasury_accounts for this org.
  const containerAccounts = await executor
    .select()
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.organizationId, organizationId),
        // Deleted accounts are soft-deleted (active=false); never show them as
        // a place in the treasury position.
        eq(treasuryAccountsSchema.active, true),
        sql`${treasuryAccountsSchema.type} IN ('caja_fuerte', 'banco', 'transito')`,
      ),
    )
    .orderBy(treasuryAccountsSchema.type, treasuryAccountsSchema.name);

  if (containerAccounts.length > 0) {
    // Aggregate credits and debits per account in two separate queries to avoid
    // the UNION complexity of a single-query approach for both-account movements.
    // Credits: SUM(amount WHERE to_account_id = id)
    const creditRows = await executor
      .select({
        accountId: sql<string>`${treasuryMovementsSchema.toAccountId}::text`,
        total: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}), 0)::text`,
      })
      .from(treasuryMovementsSchema)
      .where(
        and(
          eq(treasuryMovementsSchema.organizationId, organizationId),
          sql`${treasuryMovementsSchema.toAccountId} IS NOT NULL`,
        ),
      )
      .groupBy(treasuryMovementsSchema.toAccountId);

    // Debits: SUM(amount WHERE from_account_id = id)
    const debitRows = await executor
      .select({
        accountId: sql<string>`${treasuryMovementsSchema.fromAccountId}::text`,
        total: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}), 0)::text`,
      })
      .from(treasuryMovementsSchema)
      .where(
        and(
          eq(treasuryMovementsSchema.organizationId, organizationId),
          sql`${treasuryMovementsSchema.fromAccountId} IS NOT NULL`,
        ),
      )
      .groupBy(treasuryMovementsSchema.fromAccountId);

    const creditsMap = new Map<string, number>();
    for (const row of creditRows) {
      creditsMap.set(row.accountId, (creditsMap.get(row.accountId) ?? 0) + (Number.parseFloat(row.total) || 0));
    }
    const debitsMap = new Map<string, number>();
    for (const row of debitRows) {
      debitsMap.set(row.accountId, (debitsMap.get(row.accountId) ?? 0) + (Number.parseFloat(row.total) || 0));
    }

    for (const acct of containerAccounts) {
      const opening = Number.parseFloat(acct.openingBalance ?? '0') || 0;
      const credits = creditsMap.get(acct.id) ?? 0;
      const debits = debitsMap.get(acct.id) ?? 0;
      const key = acct.type === 'caja_fuerte'
        ? `caja_fuerte:${acct.id}`
        : acct.type === 'transito'
          ? `transito:${acct.id}`
          : `banco:${acct.name}`;
      accounts.push({
        key,
        accountId: acct.id,
        name: acct.name,
        type: acct.type as TreasuryAccountType,
        balance: balanceForAccount(opening, credits, debits),
      });
    }
  }

  return accounts;
}

// ── 2A: treasury_accounts CRUD ────────────────────────────────────────────────

export type TreasuryAccountRow = typeof treasuryAccountsSchema.$inferSelect;

export type CreateTreasuryAccountInput = {
  organizationId: string;
  type: 'caja' | 'caja_fuerte' | 'banco' | 'transito';
  name: string;
  openingBalance: string | number;
  paymentMethodId?: string | null;
  posTokenId?: string | null;
  createdBy: string;
};

/**
 * Inserts a new treasury_accounts row. Enforces unique name per org at the DB
 * level (unique index). Throws a descriptive error on conflict so callers can
 * surface it cleanly.
 */
export async function createTreasuryAccount(
  executor: Executor,
  input: CreateTreasuryAccountInput,
): Promise<TreasuryAccountRow> {
  try {
    const [row] = await executor
      .insert(treasuryAccountsSchema)
      .values({
        organizationId: input.organizationId,
        type: input.type,
        name: input.name.trim(),
        openingBalance: toMoney(input.openingBalance),
        paymentMethodId: input.paymentMethodId ?? null,
        posTokenId: input.posTokenId ?? null,
      })
      .returning();
    if (!row) {
      throw new Error('treasury_accounts: insert returned no row');
    }
    return row;
  } catch (err: unknown) {
    // Re-wrap unique-constraint violations with a human-readable message so the
    // action layer can pass it straight to the UI without string-matching.
    // pglite wraps constraint errors as "Failed query: ..." — we need to check
    // the error message AND its cause for the unique violation marker.
    const msg = err instanceof Error ? err.message : '';
    const causeMsg
      = err instanceof Error && err.cause instanceof Error
        ? err.cause.message
        : '';
    const isUniqueViolation
      = msg.includes('duplicate')
        || msg.includes('unique')
        || msg.includes('treasury_accounts_org_name_unique')
        || causeMsg.includes('duplicate')
        || causeMsg.includes('unique')
        // pglite error code for unique constraint violation
        || msg.includes('23505')
        || causeMsg.includes('23505');
    if (isUniqueViolation) {
      throw new Error(
        `ya existe una cuenta con el nombre "${input.name}" en esta organización`,
      );
    }
    throw err;
  }
}

// Payment-method types that hold money in an account (vs the cash drawer, which
// lives in cajas/caja_fuerte, or credito, which is a debt). Each of these gets a
// linked `banco` treasury account so a transfer/digital payment has a real
// destination — that is where the money lands when the transfer is confirmed.
const MONEY_METHOD_TYPES = ['transfer', 'card', 'other'] as const;

/**
 * Idempotent backfill: makes sure every active money-holding payment method has a
 * linked `banco` treasury account. Creating a payment method "opens it in
 * treasury" — but the reverse is not required (a treasury account can be a
 * standalone storage/personal account with no payment method).
 *
 * Safe to call repeatedly and from a read path (mirrors the seedIfEmpty pattern):
 * it skips methods that already have a linked account and skips names that would
 * clash with an existing account, and never throws — a residual conflict must not
 * break the caller.
 */
export async function ensurePaymentMethodAccounts(
  executor: Executor,
  organizationId: string,
  createdBy: string,
): Promise<void> {
  const methods = await executor
    .select({
      id: paymentMethodsSchema.id,
      name: paymentMethodsSchema.name,
    })
    .from(paymentMethodsSchema)
    .where(
      and(
        eq(paymentMethodsSchema.organizationId, organizationId),
        eq(paymentMethodsSchema.active, true),
        inArray(paymentMethodsSchema.type, [...MONEY_METHOD_TYPES]),
      ),
    );
  if (methods.length === 0) {
    return;
  }

  const accounts = await executor
    .select({
      name: treasuryAccountsSchema.name,
      paymentMethodId: treasuryAccountsSchema.paymentMethodId,
    })
    .from(treasuryAccountsSchema)
    .where(eq(treasuryAccountsSchema.organizationId, organizationId));

  const linkedPmIds = new Set(
    accounts
      .map(a => a.paymentMethodId)
      .filter((id): id is string => id !== null),
  );
  const usedNames = new Set(accounts.map(a => a.name.trim().toLowerCase()));

  for (const method of methods) {
    if (linkedPmIds.has(method.id)) {
      continue;
    }
    const nameKey = method.name.trim().toLowerCase();
    if (usedNames.has(nameKey)) {
      continue;
    }
    try {
      await createTreasuryAccount(executor, {
        organizationId,
        type: 'banco',
        name: method.name,
        openingBalance: 0,
        paymentMethodId: method.id,
        createdBy,
      });
      usedNames.add(nameKey);
    } catch {
      // Best-effort: a race or residual name clash must not break the caller.
    }
  }
}

/**
 * Returns all ACTIVE treasury_accounts for the org, ordered by type then name.
 */
export async function listTreasuryAccounts(
  executor: Executor,
  organizationId: string,
): Promise<TreasuryAccountRow[]> {
  return executor
    .select()
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.organizationId, organizationId),
        eq(treasuryAccountsSchema.active, true),
      ),
    )
    .orderBy(treasuryAccountsSchema.type, treasuryAccountsSchema.name);
}

/**
 * Sets active=false on a treasury_accounts row. The row is retained for
 * historical referential integrity (treasury_movements rows reference it).
 */
export async function deactivateTreasuryAccount(
  executor: Executor,
  accountId: string,
  organizationId: string,
): Promise<void> {
  await executor
    .update(treasuryAccountsSchema)
    .set({ active: false })
    .where(
      and(
        eq(treasuryAccountsSchema.id, accountId),
        eq(treasuryAccountsSchema.organizationId, organizationId),
      ),
    );
}

export type DeleteAccountResult = {
  /**
   * The balance moved to Pendiente de ubicar at deletion time (0 when the
   * account was empty). Lets the caller tell the user how much was relocated.
   */
  movedAmount: number;
};

/**
 * Deletes a caja_fuerte or banco container: moves its ENTIRE remaining balance
 * to the org's "Pendiente de ubicar" (transito) account, then deactivates it.
 * Both steps run on the SAME executor, so the caller MUST wrap this in one
 * transaction — that way the money is never stranded if a step fails.
 *
 * Guards:
 *   - account must exist, belong to the org, and still be active
 *   - only 'caja_fuerte' and 'banco' are deletable (never 'transito' or a POS 'caja')
 *   - a negative balance is rejected (anomalous — needs manual correction first)
 *
 * The row itself is kept (active=false): historical treasury_movements that
 * reference it stay intact.
 */
export async function deleteTreasuryAccountToPending(
  executor: Executor,
  args: { accountId: string; organizationId: string; createdBy: string },
): Promise<DeleteAccountResult> {
  const { accountId, organizationId, createdBy } = args;

  const [account] = await executor
    .select()
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.id, accountId),
        eq(treasuryAccountsSchema.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!account || !account.active) {
    throw new Error('cuenta no encontrada o ya eliminada');
  }
  if (account.type !== 'caja_fuerte' && account.type !== 'banco') {
    throw new Error('solo se pueden eliminar cajas fuertes y cuentas bancarias');
  }

  // Current balance via the movements ledger: opening + credits − debits.
  const [movRow] = await executor
    .select({
      credits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.toAccountId} = ${accountId}), 0)::text`,
      debits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.fromAccountId} = ${accountId}), 0)::text`,
    })
    .from(treasuryMovementsSchema)
    .where(eq(treasuryMovementsSchema.organizationId, organizationId));

  const opening = Number.parseFloat(account.openingBalance ?? '0') || 0;
  const credits = Number.parseFloat(movRow?.credits ?? '0') || 0;
  const debits = Number.parseFloat(movRow?.debits ?? '0') || 0;
  const balance = balanceForAccount(opening, credits, debits);

  if (balance < 0) {
    throw new Error(
      `la cuenta tiene saldo negativo (${balance.toFixed(2)}) y no se puede eliminar`,
    );
  }

  // Relocate any remaining balance to Pendiente de ubicar BEFORE deactivating,
  // so the company total is preserved across the deletion.
  if (balance > 0) {
    const pending = await getOrCreatePendingAccount(executor, organizationId, createdBy);
    await executor.insert(treasuryMovementsSchema).values({
      organizationId,
      fromAccountId: accountId,
      toAccountId: pending.id,
      amount: toMoney(balance),
      type: 'transfer',
      reason: `Cuenta eliminada: ${account.name}`,
      createdBy,
    });
  }

  await deactivateTreasuryAccount(executor, accountId, organizationId);

  return { movedAmount: balance };
}

/**
 * Derives the opening balance for a container type from the Phase-1
 * getTreasuryPosition derivation. Used by the 0045 seed migration and tests
 * to guarantee that the ledger starts with exactly the same value that the
 * legacy derivation would have returned at migration time.
 *
 * Supported types:
 *   'caja_fuerte' → SUM(cash_movements.withdrawal) − SUM(treasury_transfers FROM caja_fuerte)
 *   'banco'       → SUM(COALESCE(arrived, expected) WHERE status IN confirmed/mismatch)
 *                   + SUM(treasury_transfers TO banco:*)
 */
export async function seedOpeningBalance(
  executor: Executor,
  organizationId: string,
  type: 'caja_fuerte' | 'banco',
): Promise<number> {
  if (type === 'caja_fuerte') {
    // Mirror exactly what getTreasuryPosition computes for caja_fuerte:
    // total security withdrawals − total consignaciones out.
    const [safe] = await executor
      .select({
        sum: sql<string>`COALESCE(SUM(${cashMovementsSchema.amount}), 0)::text`,
      })
      .from(cashMovementsSchema)
      .where(
        and(
          eq(cashMovementsSchema.organizationId, organizationId),
          eq(cashMovementsSchema.type, 'withdrawal'),
        ),
      );
    const withdrawn = Number.parseFloat(safe?.sum ?? '0') || 0;

    const transfers = await executor
      .select({
        from: treasuryTransfersSchema.fromAccount,
        sum: sql<string>`COALESCE(SUM(${treasuryTransfersSchema.amount}), 0)::text`,
      })
      .from(treasuryTransfersSchema)
      .where(eq(treasuryTransfersSchema.organizationId, organizationId))
      .groupBy(treasuryTransfersSchema.fromAccount);

    const consignado = transfers
      .filter(t => t.from === 'caja_fuerte')
      .reduce((s, t) => s + (Number.parseFloat(t.sum) || 0), 0);

    return Number.parseFloat((withdrawn - consignado).toFixed(2));
  }

  if (type === 'banco') {
    // Mirror the Phase-1 banco derivation:
    //   R = SUM(COALESCE(arrived_amount, expected_amount)) WHERE status IN ('confirmed','mismatch')
    //   C = SUM(treasury_transfers.amount) WHERE to_account LIKE 'banco:%'
    const [reconRow] = await executor
      .select({
        sum: sql<string>`COALESCE(SUM(COALESCE(${transferReconciliationsSchema.arrivedAmount}, ${transferReconciliationsSchema.expectedAmount})), 0)::text`,
      })
      .from(transferReconciliationsSchema)
      .where(
        and(
          eq(transferReconciliationsSchema.organizationId, organizationId),
          sql`${transferReconciliationsSchema.status} IN ('confirmed', 'mismatch')`,
        ),
      );
    const reconciled = Number.parseFloat(reconRow?.sum ?? '0') || 0;

    const allTransfers = await executor
      .select({
        to: treasuryTransfersSchema.toAccount,
        sum: sql<string>`COALESCE(SUM(${treasuryTransfersSchema.amount}), 0)::text`,
      })
      .from(treasuryTransfersSchema)
      .where(eq(treasuryTransfersSchema.organizationId, organizationId))
      .groupBy(treasuryTransfersSchema.toAccount);

    const consignado = allTransfers
      .filter(t => t.to.startsWith('banco:'))
      .reduce((s, t) => s + (Number.parseFloat(t.sum) || 0), 0);

    return Number.parseFloat((reconciled + consignado).toFixed(2));
  }

  // Type-safe exhaustive check — TypeScript narrows this as unreachable.
  throw new Error(`seedOpeningBalance: unsupported type "${type as string}"`);
}

// ── 2B: treasury_movements ledger ────────────────────────────────────────────

export type TreasuryMovementRow = typeof treasuryMovementsSchema.$inferSelect;

/**
 * Pure formula: balance = opening + credits − debits.
 * credits = SUM(amount WHERE to_account_id = id)
 * debits  = SUM(amount WHERE from_account_id = id)
 *
 * Intentionally pure so callers can unit-test it without a DB.
 */
export function balanceForAccount(
  opening: number,
  credits: number,
  debits: number,
): number {
  return Number.parseFloat((opening + credits - debits).toFixed(2));
}

// ── Container row-locking helpers ────────────────────────────────────────────
//
// Closes the design-D5 gap: concurrent debits from the same treasury container
// can both pass the balance guard and overdraw it when the aggregate balance
// read is unlocked. Fix: acquire a SELECT … FOR UPDATE on the SOURCE row(s)
// BEFORE the balance scan, inside the existing tx, so concurrent debits from the
// same container serialize on the row lock.
//
// Lock-ordering rule (D2): ALL account-row locks are always acquired in ascending
// UUID order via a single SQL statement. This guarantees no two concurrent txs
// ever request the same rows in opposite order → deadlock-free by the classic
// ordered-locking proof (see design document engram #441).

/**
 * Pure helper — deduplicate and sort account IDs into ascending order.
 *
 * Always sorting before locking is the ordered-locking invariant: every caller
 * that must lock ≥2 rows will request them in the same order regardless of how
 * the caller received the IDs. No DB access; safe to unit-test in isolation.
 */
export function orderAccountIdsForLock(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Acquire a SELECT … FOR UPDATE on the specified treasury_accounts rows.
 *
 * Implementation: Drizzle ORM query with `.orderBy(id).for('update')` chained
 * together — type-safe and compatible with the TenantDb proxy (both 'orderBy'
 * and 'for' are in SELECT_CHAIN in db-context.ts). This is DISTINCT from
 * getRemainingForHandover which uses a raw sql`` template for its WHERE clause;
 * here the WHERE uses the typed Drizzle helpers (eq / inArray) and only the
 * lock and ordering are chained DSL methods.
 *
 * The single statement locks all requested rows in ascending-id order in one
 * round-trip, satisfying the ordered-locking invariant (D2). Multi-row deadlock
 * safety requires acquiring ALL needed account ids in ONE call (so they are
 * locked in ascending id order); never lock accounts across separate calls in a tx.
 *
 * Must be called INSIDE a transaction. The lock is held until the outer tx
 * commits or rolls back. Passing an empty ids array is a no-op (returns early).
 *
 * Only SOURCE (debited) accounts need a lock — destination accounts are credits
 * and have no overdraw risk (D1).
 */
export async function lockAccountsForUpdate(
  executor: Executor,
  organizationId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const ordered = orderAccountIdsForLock(ids);
  // Drizzle ORM: typed schema object (not a raw alias) keeps the call compatible
  // with the TenantDb proxy (which intercepts .from(schemaTable) and validates
  // the table name). ORDER BY + FOR UPDATE are chained via .orderBy() and .for()
  // — both are in SELECT_CHAIN (db-context.ts:108) so they pass through cleanly.
  // When executor is a TenantDb the org filter is automatically applied; the
  // explicit eq(organizationId) below is redundant but harmless — it is the
  // source-of-truth guard when executor is a raw Drizzle db or tx.
  await executor
    .select({ id: treasuryAccountsSchema.id })
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.organizationId, organizationId),
        inArray(treasuryAccountsSchema.id, ordered),
      ),
    )
    .orderBy(treasuryAccountsSchema.id)
    .for('update');
}

type TransferInput = {
  organizationId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number | string;
  createdBy: string;
  reason?: string | null;
  /** Optional: FK to originating handover movement. Set for placement rows; null for all other transfers. */
  handoverMovementId?: string | null;
};

/**
 * Records a caja↔caja (or any container↔container) transfer in the
 * treasury_movements ledger. This is AUDIT-ONLY in Phase 2 — caja balances
 * still derive from cash_sessions + cash_movements (Phase 1 path).
 *
 * Validates:
 *   - source and destination are active
 *   - source balance (opening_balance + Σ movements) ≥ amount
 *
 * Throws descriptive errors so the action layer can surface them directly.
 */
export async function recordContainerTransfer(
  executor: Executor,
  input: TransferInput,
): Promise<TreasuryMovementRow> {
  const amt = Number.parseFloat(toMoney(input.amount));

  // Load both accounts in one query to avoid two round-trips.
  // NOTE: this read happens BEFORE lockAccountsForUpdate below. That is an
  // accepted limitation: `active` and `openingBalance` are static/seed data
  // (account deactivation is a rare admin op, openingBalance never changes
  // after seeding) and are NOT part of the balance-overdraw race this change
  // targets. The critical balance scan runs AFTER the lock is acquired.
  const accounts = await executor
    .select()
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.organizationId, input.organizationId),
        sql`${treasuryAccountsSchema.id} IN (${input.fromAccountId}, ${input.toAccountId})`,
      ),
    );

  const source = accounts.find(a => a.id === input.fromAccountId);
  const dest = accounts.find(a => a.id === input.toAccountId);

  if (!source || !source.active) {
    throw new Error(
      'cuenta de origen inactiva o no encontrada — container inactive or not found',
    );
  }
  if (!dest || !dest.active) {
    throw new Error(
      'cuenta de destino inactiva o no encontrada — container inactive or not found',
    );
  }

  // Serialize concurrent debits on the SOURCE row only (D1 — destinations are
  // credits; locking them widens deadlock surface with no benefit).
  // Single-source lock → trivially ordered; ordered-locking rule (D2) still
  // satisfied because lockAccountsForUpdate always sorts by ascending id.
  await lockAccountsForUpdate(executor, input.organizationId, [input.fromAccountId]);

  // Compute current source balance via movements ledger.
  const [movRow] = await executor
    .select({
      credits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.toAccountId} = ${input.fromAccountId}), 0)::text`,
      debits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.fromAccountId} = ${input.fromAccountId}), 0)::text`,
    })
    .from(treasuryMovementsSchema)
    .where(eq(treasuryMovementsSchema.organizationId, input.organizationId));

  const opening = Number.parseFloat(source.openingBalance ?? '0') || 0;
  const credits = Number.parseFloat(movRow?.credits ?? '0') || 0;
  const debits = Number.parseFloat(movRow?.debits ?? '0') || 0;
  const currentBalance = balanceForAccount(opening, credits, debits);

  if (currentBalance < amt) {
    throw new Error(
      `saldo insuficiente: balance ${currentBalance.toFixed(2)}, requested ${amt.toFixed(2)}`,
    );
  }

  // Per-handover guard (ADR-5 C2): re-check inside executor.
  if (input.handoverMovementId) {
    const remaining = await getRemainingForHandover(executor, input.handoverMovementId, input.organizationId);
    if (amt > remaining + 0.005) {
      throw new Error(
        `excede el saldo pendiente del cierre: remaining ${remaining.toFixed(2)}, requested ${amt.toFixed(2)}`,
      );
    }
  }

  const [row] = await executor
    .insert(treasuryMovementsSchema)
    .values({
      organizationId: input.organizationId,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amount: toMoney(amt),
      type: 'transfer',
      reason: input.reason ?? null,
      handoverMovementId: input.handoverMovementId ?? null,
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error('treasury_movements: insert returned no row');
  }
  return row;
}

type BankConsignacionInput = {
  organizationId: string;
  fromAccountId: string;
  toBankAccountId: string;
  amount: number | string;
  createdBy: string;
  note?: string | null;
  /** Optional: FK to originating handover movement. Set for placement rows; null for all other consignaciones. */
  handoverMovementId?: string | null;
};

/**
 * Records a consignación (cash → banco) in the treasury_movements ledger.
 * The source container (caja or caja_fuerte) must be active and have sufficient
 * balance. The destination banco account must also be active.
 *
 * Phase 2D: treasury_transfers is now read-only. This function is the sole
 * consignacion write path.
 */
export async function recordBankConsignacion(
  executor: Executor,
  input: BankConsignacionInput,
): Promise<TreasuryMovementRow> {
  const amt = Number.parseFloat(toMoney(input.amount));

  // Load both accounts.
  // NOTE: this read happens BEFORE lockAccountsForUpdate below. That is an
  // accepted limitation: `active` and `openingBalance` are static/seed data
  // (account deactivation is a rare admin op, openingBalance never changes
  // after seeding) and are NOT part of the balance-overdraw race this change
  // targets. The critical balance scan runs AFTER the lock is acquired.
  const accounts = await executor
    .select()
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.organizationId, input.organizationId),
        sql`${treasuryAccountsSchema.id} IN (${input.fromAccountId}, ${input.toBankAccountId})`,
      ),
    );

  const source = accounts.find(a => a.id === input.fromAccountId);
  const banco = accounts.find(a => a.id === input.toBankAccountId);

  if (!source || !source.active) {
    throw new Error(
      'cuenta de origen inactiva o no encontrada — container inactive or not found',
    );
  }
  if (!banco || !banco.active) {
    throw new Error(
      'cuenta bancaria inactiva o no encontrada — container inactive or not found',
    );
  }

  // Serialize concurrent debits on the SOURCE (cash → banco). The destination
  // (banco) is a credit — no overdraw risk — so we lock source only (D1).
  await lockAccountsForUpdate(executor, input.organizationId, [input.fromAccountId]);

  // Compute source balance.
  const [movRow] = await executor
    .select({
      credits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.toAccountId} = ${input.fromAccountId}), 0)::text`,
      debits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.fromAccountId} = ${input.fromAccountId}), 0)::text`,
    })
    .from(treasuryMovementsSchema)
    .where(eq(treasuryMovementsSchema.organizationId, input.organizationId));

  const opening = Number.parseFloat(source.openingBalance ?? '0') || 0;
  const credits = Number.parseFloat(movRow?.credits ?? '0') || 0;
  const debits = Number.parseFloat(movRow?.debits ?? '0') || 0;
  const currentBalance = balanceForAccount(opening, credits, debits);

  if (currentBalance < amt) {
    throw new Error(
      `saldo insuficiente: balance ${currentBalance.toFixed(2)}, requested ${amt.toFixed(2)}`,
    );
  }

  // Per-handover guard (ADR-5 C2): when this placement is attributed to a specific
  // handover, re-check inside the executor that amt ≤ handover's remaining balance.
  if (input.handoverMovementId) {
    const remaining = await getRemainingForHandover(executor, input.handoverMovementId, input.organizationId);
    if (amt > remaining + 0.005) {
      throw new Error(
        `excede el saldo pendiente del cierre: remaining ${remaining.toFixed(2)}, requested ${amt.toFixed(2)}`,
      );
    }
  }

  const [row] = await executor
    .insert(treasuryMovementsSchema)
    .values({
      organizationId: input.organizationId,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toBankAccountId,
      amount: toMoney(amt),
      type: 'consignacion',
      reason: input.note ?? null,
      handoverMovementId: input.handoverMovementId ?? null,
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error('treasury_movements: insert returned no row');
  }
  return row;
}

// ── 2C: gasto outflow (dual linked record) ────────────────────────────────────

type GastoOutflowInput = {
  organizationId: string;
  fromAccountId: string;
  amount: number | string;
  category: string;
  description?: string | null;
  incurredOn: string; // ISO date string e.g. '2026-06-15'
  createdBy: string;
  reason?: string | null;
  /** Optional: FK to originating handover movement. Set for placement rows; null for all other gastos. */
  handoverMovementId?: string | null;
};

/**
 * Atomically inserts one `expenses` row (P&L record — schema unchanged) and
 * one `treasury_movements` row (type='gasto', from_account_id=selected container,
 * expense_id=new expense.id). Both succeed or both roll back.
 *
 * Balance check: source container must have sufficient balance BEFORE either
 * insert. If balance < amount, throws "saldo insuficiente" and writes nothing.
 *
 * Returns the new expense.id so the action layer can log it.
 *
 * Constraints:
 * - Does NOT touch cash_movements (hot sales path sealed — AC-6).
 * - expensesSchema columns are UNCHANGED — no structural alteration.
 * - net-profit.ts continues reading expensesSchema only (AC-3).
 */
export async function recordGastoOutflow(
  executor: Executor,
  input: GastoOutflowInput,
): Promise<string> {
  const amt = Number.parseFloat(toMoney(input.amount));

  // Load source container.
  const [source] = await executor
    .select()
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.id, input.fromAccountId),
        eq(treasuryAccountsSchema.organizationId, input.organizationId),
      ),
    )
    .limit(1);

  if (!source || !source.active) {
    throw new Error(
      'cuenta de origen inactiva o no encontrada — container inactive or not found',
    );
  }

  const doInserts = async (tx: Executor): Promise<string> => {
    // Serialize concurrent debits on the source row. The lock MUST be acquired
    // inside the tx (doInserts) so it is held until the outer tx commits/rolls
    // back. Acquiring it here, before the balance scan, ensures two concurrent
    // txs on the same container serialize at this point rather than both reading
    // a sufficient balance and both committing an overdraw.
    await lockAccountsForUpdate(tx, input.organizationId, [input.fromAccountId]);

    // Re-read balance INSIDE the tx (after lock) — this is the authoritative
    // check. Concurrent txs serialized by the lock will see the committed debit.
    const [movRow] = await tx
      .select({
        credits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.toAccountId} = ${input.fromAccountId}), 0)::text`,
        debits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.fromAccountId} = ${input.fromAccountId}), 0)::text`,
      })
      .from(treasuryMovementsSchema)
      .where(eq(treasuryMovementsSchema.organizationId, input.organizationId));

    const opening = Number.parseFloat(source.openingBalance ?? '0') || 0;
    const credits = Number.parseFloat(movRow?.credits ?? '0') || 0;
    const debits = Number.parseFloat(movRow?.debits ?? '0') || 0;
    const currentBalance = balanceForAccount(opening, credits, debits);

    if (currentBalance < amt) {
      throw new Error(
        `saldo insuficiente: balance ${currentBalance.toFixed(2)}, requested ${amt.toFixed(2)}`,
      );
    }

    // Per-handover guard (ADR-5 C2): re-check inside tx.
    if (input.handoverMovementId) {
      const remaining = await getRemainingForHandover(tx, input.handoverMovementId, input.organizationId);
      if (amt > remaining + 0.005) {
        throw new Error(
          `excede el saldo pendiente del cierre: remaining ${remaining.toFixed(2)}, requested ${amt.toFixed(2)}`,
        );
      }
    }

    // 1. Insert expenses row (P&L — schema unchanged).
    const [expense] = await tx
      .insert(expensesSchema)
      .values({
        organizationId: input.organizationId,
        amount: toMoney(amt),
        category: input.category,
        description: input.description ?? null,
        incurredOn: input.incurredOn,
        createdBy: input.createdBy,
      })
      .returning({ id: expensesSchema.id });

    if (!expense) {
      throw new Error('expenses: insert returned no row');
    }

    // 2. Insert treasury_movements gasto row linked by expense_id.
    const [movement] = await tx
      .insert(treasuryMovementsSchema)
      .values({
        organizationId: input.organizationId,
        fromAccountId: input.fromAccountId,
        toAccountId: null,
        amount: toMoney(amt),
        type: 'gasto',
        category: input.category,
        reason: input.reason ?? input.description ?? null,
        expenseId: expense.id,
        handoverMovementId: input.handoverMovementId ?? null,
        createdBy: input.createdBy,
      })
      .returning({ id: treasuryMovementsSchema.id });

    if (!movement) {
      throw new Error('treasury_movements: gasto insert returned no row');
    }

    return expense.id;
  };

  // When executor is the top-level `db` singleton, open a dedicated transaction.
  // When executor is already a transaction object (e.g. a Drizzle tx passed from
  // a parent transaction, or a TenantDb tx proxy), call doInserts directly — the
  // `.transaction` property is still present on a Drizzle tx (it exposes the
  // underlying tx), so this check is NOT a reliable "is-standalone" test.
  // In practice, standalone callers pass the `db` singleton (has `.transaction`
  // as a function on the module), while callers inside a parent tx pass the tx
  // object directly and this branch is not reached. If a tx is passed directly,
  // doInserts nests a SAVEPOINT (harmless; rollback still propagates to the parent).
  const isRealDb = typeof (executor as { transaction?: unknown }).transaction === 'function';
  if (isRealDb) {
    return (executor as typeof import('@/libs/DB').db).transaction(tx => doInserts(tx as unknown as Executor));
  }
  return doInserts(executor);
}

// ── Phase 3 PR4: opt-in config flag ──────────────────────────────────────────

// treasury-sweep-model slice 2: TREASURY_HANDOVER_SETTING_KEY and
// getTreasuryHandoverEnabled removed. The at-close handover flag was retired in
// slice 1 (handoverBySession subtraction decoupled). Sweep destination is
// configured per-caja only (resolveSweepDestination below).

// ── Slice 2: per-caja sweep destination resolver ─────────────────────────────

export type SweepDestination = {
  accountId: string;
  isCofre: true;
};

/**
 * Resolves the auto-route destination for a caja's open-time sweep.
 * Priority: per-caja FK column → null (Pendiente de ubicar).
 *
 * Only returns a destination when:
 *   - The resolved account exists in the org
 *   - It is active
 *   - It is type='caja_fuerte' (cofre-only rule, ADR-4)
 *
 * Returns null on any failure (inactive, wrong type, missing). The open route
 * uses this as a signal to fall back to Pendiente de ubicar silently.
 */
export async function resolveSweepDestination(
  executor: Executor,
  organizationId: string,
  posTokenId: string | null | undefined,
): Promise<SweepDestination | null> {
  let candidateId: string | null = null;

  // Per-caja column is the only sweep destination source.
  if (posTokenId) {
    const [tokenRow] = await executor
      .select({
        defaultSweepDestinationAccountId:
          posTokensSchema.defaultSweepDestinationAccountId,
      })
      .from(posTokensSchema)
      .where(eq(posTokensSchema.id, posTokenId))
      .limit(1);
    candidateId = tokenRow?.defaultSweepDestinationAccountId ?? null;
  }

  if (!candidateId) {
    return null;
  }

  // 3. Validate: must be active + caja_fuerte within this org
  const [account] = await executor
    .select({
      id: treasuryAccountsSchema.id,
      type: treasuryAccountsSchema.type,
      active: treasuryAccountsSchema.active,
    })
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.id, candidateId),
        eq(treasuryAccountsSchema.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!account || !account.active || account.type !== 'caja_fuerte') {
    // Inactive, wrong type, or not found — degrade to Pendiente silently
    return null;
  }

  return { accountId: account.id, isCofre: true };
}

// ── Slice 3: Inflows model ────────────────────────────────────────────────────

export type InflowSourceDebitInput = {
  organizationId: string;
  fromAccountId: string;
  amount: number | string;
  reason: string;
  createdBy: string;
};

/**
 * Records a treasury_movements type='salida' to debit a source container when
 * a cashier posts an internal-origin entrada (cash coming into a caja FROM a
 * cofre, banco, or other treasury container).
 *
 * fromAccountId = source container (caja_fuerte, banco, transito — active, in-org)
 * toAccountId   = NULL (the credit side lands in cash_movements, not treasury_accounts)
 *
 * Validates:
 *   - source account exists + is active within this org
 *   - source has sufficient balance for the requested amount
 *
 * Throws descriptive errors that the movement route surfaces directly.
 */
export async function recordInflowSourceDebit(
  executor: Executor,
  input: InflowSourceDebitInput,
): Promise<TreasuryMovementRow> {
  const amt = Number.parseFloat(toMoney(input.amount));

  // Validate source: must be active and belong to this org.
  const [source] = await executor
    .select({
      id: treasuryAccountsSchema.id,
      active: treasuryAccountsSchema.active,
      openingBalance: treasuryAccountsSchema.openingBalance,
    })
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.id, input.fromAccountId),
        eq(treasuryAccountsSchema.organizationId, input.organizationId),
      ),
    )
    .limit(1);

  if (!source || !source.active) {
    throw new Error(
      'cuenta de origen inactiva o no encontrada — source container inactive or not found',
    );
  }

  // Serialize concurrent debits: lock the source row before the balance scan so
  // two concurrent txs on the same container cannot both read a sufficient balance
  // and both commit an overdraw. Lock acquired here; released at outer tx commit.
  await lockAccountsForUpdate(executor, input.organizationId, [input.fromAccountId]);

  // Compute current source balance via movements ledger.
  const [movRow] = await executor
    .select({
      credits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.toAccountId} = ${input.fromAccountId}), 0)::text`,
      debits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.fromAccountId} = ${input.fromAccountId}), 0)::text`,
    })
    .from(treasuryMovementsSchema)
    .where(eq(treasuryMovementsSchema.organizationId, input.organizationId));

  const opening = Number.parseFloat(source.openingBalance ?? '0') || 0;
  const credits = Number.parseFloat(movRow?.credits ?? '0') || 0;
  const debits = Number.parseFloat(movRow?.debits ?? '0') || 0;
  const currentBalance = balanceForAccount(opening, credits, debits);

  if (currentBalance < amt) {
    throw new Error(
      `saldo insuficiente en la cuenta de origen: balance ${currentBalance.toFixed(2)}, requested ${amt.toFixed(2)}`,
    );
  }

  const [row] = await executor
    .insert(treasuryMovementsSchema)
    .values({
      organizationId: input.organizationId,
      fromAccountId: input.fromAccountId,
      toAccountId: null,
      amount: toMoney(amt),
      type: 'salida',
      reason: input.reason,
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error('treasury_movements: inflow source debit insert returned no row');
  }
  return row;
}

// ── Phase 3: Handover ledger foundation ──────────────────────────────────────

/**
 * Lazy-seeds ONE `transito` (Pendiente de ubicar) treasury account per org.
 * Safe to call inside a transaction — idempotent on re-entry (race-safe via
 * the unique org+name constraint: on conflict it re-selects the existing row
 * rather than throwing, so a close-tx is never aborted by a race here).
 */
export async function getOrCreatePendingAccount(
  executor: Executor,
  organizationId: string,
  createdBy: string,
): Promise<TreasuryAccountRow> {
  // SELECT the existing transito account first (common path after first close).
  const [existing] = await executor
    .select()
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.organizationId, organizationId),
        sql`${treasuryAccountsSchema.type} = 'transito'`,
        eq(treasuryAccountsSchema.active, true),
      ),
    )
    .limit(1);

  if (existing) {
    return existing;
  }

  // First close for this org — create the account.
  try {
    return await createTreasuryAccount(executor, {
      organizationId,
      type: 'transito',
      name: 'Pendiente de ubicar',
      openingBalance: 0,
      createdBy,
    });
  } catch (err: unknown) {
    // Race condition: a concurrent close may have created the transito account
    // between our SELECT and INSERT. Re-select on ANY creation failure — no
    // message/code matching, so it stays robust to translation or error-wrapper
    // changes — and use the row if it appeared. Only propagate if it still isn't
    // there. NEVER throw out of a close transaction for a benign race.
    const [raceRow] = await executor
      .select()
      .from(treasuryAccountsSchema)
      .where(
        and(
          eq(treasuryAccountsSchema.organizationId, organizationId),
          sql`${treasuryAccountsSchema.type} = 'transito'`,
        ),
      )
      .limit(1);
    if (raceRow) {
      return raceRow;
    }
    throw err;
  }
}

type HandoverMovementInput = {
  organizationId: string;
  toAccountId: string;
  amount: number | string;
  createdBy: string;
  cashSessionId: string;
  reason?: string | null;
};

/**
 * Inserts a type='handover' movement: from=NULL → to=transito account.
 * Called inside the close transaction AFTER the session UPDATE.
 * Carries cash_session_id so the caja card can identify the session's handover.
 *
 * NEVER call this when amount === 0 — guard the caller with:
 *   if (Number.parseFloat(counted) > 0) { await recordHandoverMovement(...) }
 */
export async function recordHandoverMovement(
  executor: Executor,
  input: HandoverMovementInput,
): Promise<TreasuryMovementRow> {
  const [row] = await executor
    .insert(treasuryMovementsSchema)
    .values({
      organizationId: input.organizationId,
      fromAccountId: null,
      toAccountId: input.toAccountId,
      amount: toMoney(input.amount),
      type: 'handover',
      reason: input.reason ?? null,
      cashSessionId: input.cashSessionId,
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error('treasury_movements: handover insert returned no row');
  }
  return row;
}

// ── Slice C: Financial Timeline ───────────────────────────────────────────────

export type TreasuryTimelineEntry = {
  id: string;
  createdAt: Date;
  type: string;
  fromAccount: string | null;
  toAccount: string | null;
  amount: number;
};

/**
 * Returns treasury movements in reverse-chronological order for the timeline.
 * Each entry resolves fromAccount and toAccount names from treasury_accounts.
 *
 * Reads treasury_movements only (ordered by created_at DESC). The timeline is
 * read-only — no writes occur here.
 *
 * @param executor - DB executor (real db or transaction)
 * @param organizationId - org to scope results
 * @param limit - max rows to return (default 100)
 */
// Columns selected for every timeline read — shared by the recent-view and the
// filtered/paginated full-history query so both resolve identically.
const TIMELINE_MOVEMENT_FIELDS = {
  id: treasuryMovementsSchema.id,
  createdAt: treasuryMovementsSchema.createdAt,
  type: treasuryMovementsSchema.type,
  fromAccountId: treasuryMovementsSchema.fromAccountId,
  toAccountId: treasuryMovementsSchema.toAccountId,
  amount: treasuryMovementsSchema.amount,
};

export async function listTreasuryTimeline(
  executor: Executor,
  organizationId: string,
  limit = 100,
): Promise<TreasuryTimelineEntry[]> {
  // Fetch movements ordered newest-first.
  const movements = await executor
    .select(TIMELINE_MOVEMENT_FIELDS)
    .from(treasuryMovementsSchema)
    .where(eq(treasuryMovementsSchema.organizationId, organizationId))
    .orderBy(desc(treasuryMovementsSchema.createdAt))
    .limit(limit);

  return resolveTimelineEntries(executor, organizationId, movements);
}

type RawTimelineMovement = {
  id: string;
  createdAt: Date;
  type: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  amount: string | null;
};

/**
 * Resolves raw treasury_movements rows into display-ready timeline entries by
 * looking up the from/to account names in a single query. Pure mapping — no
 * ordering or filtering happens here (the caller owns the query shape).
 */
async function resolveTimelineEntries(
  executor: Executor,
  organizationId: string,
  movements: RawTimelineMovement[],
): Promise<TreasuryTimelineEntry[]> {
  if (movements.length === 0) {
    return [];
  }

  // Collect unique account IDs to resolve names in a single query.
  const accountIdSet = new Set<string>();
  for (const m of movements) {
    if (m.fromAccountId) {
      accountIdSet.add(m.fromAccountId);
    }
    if (m.toAccountId) {
      accountIdSet.add(m.toAccountId);
    }
  }

  const nameMap = new Map<string, string>();
  if (accountIdSet.size > 0) {
    const accountIds = [...accountIdSet];
    const accounts = await executor
      .select({
        id: treasuryAccountsSchema.id,
        name: treasuryAccountsSchema.name,
      })
      .from(treasuryAccountsSchema)
      .where(
        and(
          inArray(treasuryAccountsSchema.id, accountIds),
          eq(treasuryAccountsSchema.organizationId, organizationId),
        ),
      );

    for (const a of accounts) {
      nameMap.set(a.id, a.name);
    }
  }

  return movements.map(m => ({
    id: m.id,
    createdAt: m.createdAt,
    type: m.type,
    fromAccount: m.fromAccountId ? (nameMap.get(m.fromAccountId) ?? null) : null,
    toAccount: m.toAccountId ? (nameMap.get(m.toAccountId) ?? null) : null,
    amount: Number.parseFloat(m.amount ?? '0') || 0,
  }));
}

export type TreasuryTimelineFilter = {
  /** Inclusive lower bound on the movement's calendar date (YYYY-MM-DD). */
  start?: string;
  /** Inclusive upper bound on the movement's calendar date (YYYY-MM-DD). */
  end?: string;
  /** Movement type (treasury_movement_type). Omit for all types. */
  type?: string;
  /** Match movements where this account is the source OR the destination. */
  accountId?: string;
};

export type TreasuryTimelinePage = {
  rows: TreasuryTimelineEntry[];
  /** Total rows matching the filter, ignoring limit/offset — drives pagination. */
  total: number;
};

/**
 * Filtered + paginated treasury timeline for the full-history page. Same
 * read-only semantics as listTreasuryTimeline (newest-first, account names
 * resolved) plus optional date-range / type / account filters and a total count.
 *
 * Date filters compare on the calendar date of created_at via a ::date cast, so
 * they are timezone-agnostic against the stored naive timestamp. `args.limit` is
 * the page size and `args.offset` the rows to skip (page index * limit).
 */
export async function listTreasuryTimelinePage(
  executor: Executor,
  organizationId: string,
  args: TreasuryTimelineFilter & { limit: number; offset: number },
): Promise<TreasuryTimelinePage> {
  const conditions = [eq(treasuryMovementsSchema.organizationId, organizationId)];

  if (args.start) {
    conditions.push(sql`${treasuryMovementsSchema.createdAt}::date >= ${args.start}::date`);
  }
  if (args.end) {
    conditions.push(sql`${treasuryMovementsSchema.createdAt}::date <= ${args.end}::date`);
  }
  if (args.type) {
    conditions.push(sql`${treasuryMovementsSchema.type} = ${args.type}`);
  }
  if (args.accountId) {
    conditions.push(
      or(
        eq(treasuryMovementsSchema.fromAccountId, args.accountId),
        eq(treasuryMovementsSchema.toAccountId, args.accountId),
      )!,
    );
  }

  const whereClause = and(...conditions);

  const [movements, totalRows] = await Promise.all([
    executor
      .select(TIMELINE_MOVEMENT_FIELDS)
      .from(treasuryMovementsSchema)
      .where(whereClause)
      .orderBy(desc(treasuryMovementsSchema.createdAt))
      .limit(args.limit)
      .offset(args.offset),
    executor
      .select({ value: count() })
      .from(treasuryMovementsSchema)
      .where(whereClause),
  ]);

  const total = totalRows[0]?.value ?? 0;
  const rows = await resolveTimelineEntries(executor, organizationId, movements);

  return { rows, total };
}

// ── Slice E: confirmed-transfer → bank deposit bridge ─────────────────────────
// A confirmed customer transfer must land in a bank treasury account, so the
// company total reflects it ("the money never disappears"). The only link from a
// transfer to a method is the free-text `method` string (sale_payments has no
// payment_method FK), so we resolve the bank by name.

// Maps a transfer method label to its bank treasury account. Returns the account
// id ONLY when the method resolves to exactly ONE active bank — ambiguous or no
// match returns null so the caller skips the deposit (never guess where money
// lands). Match is case-insensitive against the configured transfer method name.
export async function resolveBancoForMethod(
  executor: Executor,
  args: { organizationId: string; method: string },
): Promise<string | null> {
  const rows = await executor
    .select({ id: treasuryAccountsSchema.id })
    .from(treasuryAccountsSchema)
    .innerJoin(
      paymentMethodsSchema,
      eq(paymentMethodsSchema.id, treasuryAccountsSchema.paymentMethodId),
    )
    .where(
      and(
        eq(treasuryAccountsSchema.organizationId, args.organizationId),
        eq(treasuryAccountsSchema.type, 'banco'),
        eq(treasuryAccountsSchema.active, true),
        eq(paymentMethodsSchema.type, 'transfer'),
        sql`lower(${paymentMethodsSchema.name}) = lower(${args.method})`,
      ),
    )
    .limit(2);

  return rows.length === 1 ? (rows[0]?.id ?? null) : null;
}

// Records the bank deposit for a confirmed transfer, idempotently. The unique
// index on transfer_reconciliation_id means a second confirm (or a bulk confirm
// that re-touches the row) cannot double-credit the bank — the conflicting insert
// is a no-op. Returns whether a NEW deposit row was written. When the method does
// not resolve to a bank, no deposit is made (deposited=false) and confirming is
// NOT blocked. Run inside the same transaction as the status change for atomicity.
export async function depositConfirmedTransfer(
  executor: Executor,
  args: {
    organizationId: string;
    reconciliationId: string;
    method: string;
    amount: number | string;
    createdBy: string;
  },
): Promise<{ deposited: boolean }> {
  const bancoId = await resolveBancoForMethod(executor, {
    organizationId: args.organizationId,
    method: args.method,
  });
  if (!bancoId) {
    return { deposited: false };
  }

  const inserted = await executor
    .insert(treasuryMovementsSchema)
    .values({
      organizationId: args.organizationId,
      fromAccountId: null,
      toAccountId: bancoId,
      amount: toMoney(args.amount),
      type: 'entrada',
      reason: 'Transferencia confirmada',
      transferReconciliationId: args.reconciliationId,
      createdBy: args.createdBy,
    })
    .onConflictDoNothing()
    .returning({ id: treasuryMovementsSchema.id });

  return { deposited: inserted.length > 0 };
}

// Keeps the bank in sync when an ALREADY-confirmed transfer is corrected. The
// original deposit is immutable and unique per reconciliation, so a correction is
// posted as a SEPARATE, unlinked compensating movement for the delta between what
// the bank was previously credited and the corrected amount:
//   delta > 0 → an `entrada` topping the bank up,
//   delta < 0 → a `salida` clawing the over-credit back (e.g. it never arrived).
// Returns the signed delta applied (0 when there is nothing to adjust or the
// method resolves to no bank account). MUST run inside the correction transaction
// so the status change and the bank adjustment commit together — the bank can
// never drift from the reconciliation.
export async function adjustConfirmedTransferDeposit(
  executor: Executor,
  args: {
    organizationId: string;
    method: string;
    previousBankAmount: number | string;
    newBankAmount: number | string;
    createdBy: string;
    reference?: string | null;
  },
): Promise<{ adjusted: number }> {
  const previous = Number.parseFloat(toMoney(args.previousBankAmount)) || 0;
  const next = Number.parseFloat(toMoney(args.newBankAmount)) || 0;
  const delta = Number.parseFloat((next - previous).toFixed(2));
  if (delta === 0) {
    return { adjusted: 0 };
  }

  const bancoId = await resolveBancoForMethod(executor, {
    organizationId: args.organizationId,
    method: args.method,
  });
  if (!bancoId) {
    return { adjusted: 0 };
  }

  const isCredit = delta > 0;
  await executor.insert(treasuryMovementsSchema).values({
    organizationId: args.organizationId,
    fromAccountId: isCredit ? null : bancoId,
    toAccountId: isCredit ? bancoId : null,
    amount: toMoney(Math.abs(delta)),
    type: isCredit ? 'entrada' : 'salida',
    reason: args.reference
      ? `Corrección de transferencia confirmada · Ref. ${args.reference}`
      : 'Corrección de transferencia confirmada',
    createdBy: args.createdBy,
  });

  return { adjusted: delta };
}

// ── Phase 3 PR3: per-handover remaining + settled state ───────────────────────

/**
 * Returns the remaining unplaced amount for a specific handover movement row.
 * remaining = handover.amount − Σ(amount WHERE handover_movement_id = handoverId)
 *
 * Must be called INSIDE a transaction. Takes a `FOR UPDATE` lock on the handover
 * row so that concurrent placements cannot both read the same remaining and both
 * pass the guard (serialises the per-handover guard writes).
 *
 * `organizationId` is mandatory — cross-org access returns 0, preventing a caller
 * from passing another org's handoverId and attributing placements to it.
 */
export async function getRemainingForHandover(
  executor: Executor,
  handoverId: string,
  organizationId: string,
): Promise<number> {
  // Lock the handover row + compute remaining in one query.
  // The FOR UPDATE prevents concurrent placements from racing past the guard.
  const [row] = await executor
    .select({
      remaining: sql<string>`(
        tm.amount - COALESCE((
          SELECT SUM(p.amount)
          FROM treasury_movements p
          WHERE p.handover_movement_id = tm.id
        ), 0)
      )::text`,
    })
    .from(sql`treasury_movements tm`)
    .where(sql`tm.id = ${handoverId} AND tm.organization_id = ${organizationId} FOR UPDATE`);

  return Number.parseFloat(row?.remaining ?? '0') || 0;
}

/**
 * For each session ID in the input array, returns whether a handover movement
 * row exists for that session (type='handover', cash_session_id = sessionId).
 * Used by the caja card to show the "entregado" label.
 *
 * Scoped to the org to prevent cross-org leaks.
 * Returns a Map<sessionId, boolean> with false as default for sessions without handovers.
 */
export async function getHandoverStatusForSessions(
  executor: Executor,
  organizationId: string,
  sessionIds: string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (sessionIds.length === 0) {
    return result;
  }

  // Initialize all to false
  for (const id of sessionIds) {
    result.set(id, false);
  }

  const rows = await executor
    .select({
      cashSessionId: sql<string>`cash_session_id::text`,
    })
    .from(treasuryMovementsSchema)
    .where(
      sql`organization_id = ${organizationId}
        AND type = 'handover'
        AND cash_session_id = ANY(ARRAY[${sql.join(sessionIds.map(id => sql`${id}::uuid`), sql`, `)}])`,
    );

  for (const row of rows) {
    if (row.cashSessionId) {
      result.set(row.cashSessionId, true);
    }
  }

  return result;
}

// ── Phase 3 PR2: placement helpers + badge counter ────────────────────────────

export type PendingHandover = {
  /** ID of the handover treasury_movements row — used as handoverMovementId in placements. */
  id: string;
  /** Original amount credited to Pendiente at close time. */
  amount: number;
  /** Remaining balance: amount − Σ(placed). */
  remaining: number;
  /** When the handover was created (close time). */
  createdAt: Date;
  /**
   * Name of the POS device (caja) that generated the handover.
   * Sourced from pos_tokens.device_name via the session's pos_token_id.
   * Falls back to "Cierre de caja" when there is no linked device.
   */
  origin: string;
  /**
   * Who closed the session. Sourced from cash_sessions.closed_by (free text set
   * by the POS at close time — already a resolved display name on the device).
   * Null when no linked session or the session has no closedBy value.
   */
  cashierName: string | null;
};

/**
 * Returns the list of pending handover movements with their remaining balances,
 * enriched with origin (device name) and cashierName (who closed the session).
 * A handover is "pending" while remaining > 0.
 * Used by the placement queue (AllocateModal) to show the recap header
 * "De dónde salió / Cuándo / Quién la tenía".
 */
export async function listPendingHandovers(
  executor: Executor,
  organizationId: string,
): Promise<PendingHandover[]> {
  const rows = await executor
    .select({
      id: sql<string>`h.id::text`,
      amount: sql<string>`h.amount::text`,
      remaining: sql<string>`(h.amount - COALESCE(p.placed, 0))::text`,
      createdAt: sql<Date>`h.created_at`,
      // cash_sessions.closed_by is the display name set by the POS at close time
      cashierName: sql<string | null>`cs.closed_by`,
      // device name from pos_tokens; null when no device (admin/legacy session)
      deviceName: sql<string | null>`pt.device_name`,
      // reason is used as origin fallback for recovery handovers (no session/device)
      reason: sql<string | null>`h.reason`,
    })
    .from(sql`treasury_movements h`)
    .leftJoin(
      sql`(
        SELECT handover_movement_id, SUM(amount)::numeric AS placed
        FROM treasury_movements
        WHERE handover_movement_id IS NOT NULL
        GROUP BY handover_movement_id
      ) p`,
      sql`p.handover_movement_id = h.id`,
    )
    .leftJoin(
      sql`cash_sessions cs`,
      sql`cs.id = h.cash_session_id`,
    )
    .leftJoin(
      sql`pos_tokens pt`,
      sql`pt.id = cs.pos_token_id`,
    )
    .where(
      sql`h.organization_id = ${organizationId}
        AND h.type = 'handover'
        AND (h.amount - COALESCE(p.placed, 0)) > 0`,
    )
    .orderBy(sql`h.created_at ASC`);

  return rows.map(r => ({
    id: r.id,
    amount: Number.parseFloat(r.amount) || 0,
    remaining: Number.parseFloat(r.remaining) || 0,
    createdAt: new Date(r.createdAt),
    origin: r.deviceName ?? r.reason ?? 'Cierre de caja',
    cashierName: r.cashierName ?? null,
  }));
}

/**
 * Returns the count and outstanding aggregate total of handover movements that
 * have not yet been fully placed. A handover is "pending" while:
 *   remaining = handover.amount − Σ(amount WHERE handover_movement_id = handover.id) > 0
 *
 * Mirrors countPendingReconciliations in transfer-reconciliation.ts.
 * Feeds the "$X sin ubicar" badge on the dashboard treasury page.
 */
export async function countPendingHandovers(
  executor: Executor,
  organizationId: string,
): Promise<{ count: number; total: number }> {
  const [row] = await executor
    .select({
      count: sql<number>`COUNT(*)::int`,
      total: sql<string>`COALESCE(SUM(h.amount - COALESCE(p.placed, 0)), 0)::text`,
    })
    .from(sql`treasury_movements h`)
    .leftJoin(
      sql`(
        SELECT handover_movement_id, SUM(amount)::numeric AS placed
        FROM treasury_movements
        WHERE handover_movement_id IS NOT NULL
        GROUP BY handover_movement_id
      ) p`,
      sql`p.handover_movement_id = h.id`,
    )
    .where(
      sql`h.organization_id = ${organizationId}
        AND h.type = 'handover'
        AND (h.amount - COALESCE(p.placed, 0)) > 0`,
    );

  return {
    count: Number(row?.count ?? 0),
    total: Number.parseFloat(row?.total ?? '0') || 0,
  };
}

// ── Supplier payment outflow ──────────────────────────────────────────────────

/**
 * Input for a supplier payment that debits a treasury container.
 * Payments are ASSETS (inventory purchase), never P&L — no expenses row.
 */
export type SupplierPaymentOutflowInput = {
  organizationId: string;
  /** Treasury container to debit (caja_fuerte | banco | caja, active, in-org). */
  fromAccountId: string;
  amount: number | string;
  supplierId: string;
  /** null only for future ad-hoc payments; v1 always set. */
  payableId: string | null;
  note?: string | null;
  createdBy: string;
};

export type SupplierPaymentOutflowResult = {
  paymentId: string;
  treasuryMovementId: string;
  payableStatus: 'open' | 'partial' | 'paid';
};

/**
 * Records a supplier payment as a treasury SALIDA (not gasto — ASSET, not P&L).
 *
 * Copied verbatim from recordInflowSourceDebit / recordGastoOutflow (D5):
 * org-wide balance scan, same balance guard pattern, same isRealDb tx wrapping.
 *
 * Writes:
 *   1. treasury_movements (type='salida', from=container, to=null) — NO expense_id.
 *   2. supplier_payments (payableId, treasuryMovementId, amount) — atomically.
 *   3. supplier_payables UPDATE: paid_amount += amount, status recomputed.
 *
 * Constraints (REQ-4.x):
 *   - amount ≤ 0 → throw.
 *   - balance < amount → throw "saldo insuficiente".
 *   - payable.status === 'paid' → throw.
 *   - amount > outstanding + 0.005 epsilon → throw "excede el saldo pendiente".
 *   - treasury_movement_id on supplier_payments is ALWAYS non-null (migration 0066).
 *
 * Does NOT call recordPosGastoBridge or recordGastoOutflow.
 */
export async function recordSupplierPaymentOutflow(
  executor: Executor,
  input: SupplierPaymentOutflowInput,
): Promise<SupplierPaymentOutflowResult> {
  const amt = Number.parseFloat(toMoney(input.amount));

  if (amt <= 0) {
    throw new Error(
      `monto inválido: el pago debe ser mayor a cero (got ${String(input.amount)})`,
    );
  }

  const doWork = async (tx: Executor): Promise<SupplierPaymentOutflowResult> => {
    // 1. Load + validate source container (same as recordGastoOutflow).
    const [source] = await tx
      .select({
        id: treasuryAccountsSchema.id,
        active: treasuryAccountsSchema.active,
        openingBalance: treasuryAccountsSchema.openingBalance,
      })
      .from(treasuryAccountsSchema)
      .where(
        and(
          eq(treasuryAccountsSchema.id, input.fromAccountId),
          eq(treasuryAccountsSchema.organizationId, input.organizationId),
        ),
      )
      .limit(1);

    if (!source || !source.active) {
      throw new Error(
        'cuenta de origen inactiva o no encontrada — container inactive or not found',
      );
    }

    // 2. Lock the SOURCE container BEFORE the balance scan AND before the payable
    // FOR UPDATE (D3 — global lock order: treasury_accounts → supplier_payables).
    // This ensures: (a) concurrent debits from the same container serialize at this
    // point; (b) no tx can take the payable lock before the container lock, so no
    // cross-table cycle is possible (no other helper locks supplier_payables, making
    // the treasury_accounts → supplier_payables order globally consistent).
    await lockAccountsForUpdate(tx, input.organizationId, [input.fromAccountId]);

    // 3. Org-wide balance scan (AFTER container lock — see note above).
    const [movRow] = await tx
      .select({
        credits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.toAccountId} = ${input.fromAccountId}), 0)::text`,
        debits: sql<string>`COALESCE(SUM(${treasuryMovementsSchema.amount}) FILTER (WHERE ${treasuryMovementsSchema.fromAccountId} = ${input.fromAccountId}), 0)::text`,
      })
      .from(treasuryMovementsSchema)
      .where(eq(treasuryMovementsSchema.organizationId, input.organizationId));

    const opening = Number.parseFloat(source.openingBalance ?? '0') || 0;
    const credits = Number.parseFloat(movRow?.credits ?? '0') || 0;
    const debits = Number.parseFloat(movRow?.debits ?? '0') || 0;
    const currentBalance = balanceForAccount(opening, credits, debits);

    if (currentBalance < amt) {
      throw new Error(
        `saldo insuficiente: balance ${currentBalance.toFixed(2)}, requested ${amt.toFixed(2)}`,
      );
    }

    // 4. If payableId: validate payable status + outstanding cap (SELECT ... FOR UPDATE).
    // Container lock is already held — payable lock acquired after (treasury_accounts → supplier_payables order).
    let payableStatus: 'open' | 'partial' | 'paid' = 'open';
    let newPaidAmount = amt;

    if (input.payableId) {
      const [payable] = await tx
        .select({
          id: supplierPayablesSchema.id,
          organizationId: supplierPayablesSchema.organizationId,
          totalAmount: supplierPayablesSchema.totalAmount,
          paidAmount: supplierPayablesSchema.paidAmount,
          // creditedAmount: return credits reduce outstanding (migration 0068).
          creditedAmount: supplierPayablesSchema.creditedAmount,
          status: supplierPayablesSchema.status,
        })
        .from(supplierPayablesSchema)
        .where(eq(supplierPayablesSchema.id, input.payableId))
        .for('update')
        .limit(1);

      if (!payable) {
        throw new Error(`payable not found: ${input.payableId}`);
      }

      if (payable.organizationId !== input.organizationId) {
        throw new Error('payable does not belong to this organization');
      }

      if (payable.status === 'paid') {
        throw new Error('payable already paid — no additional payments accepted');
      }

      const totalAmt = Number.parseFloat(payable.totalAmount);
      const alreadyPaid = Number.parseFloat(payable.paidAmount);
      // outstanding = total − paid − credited (migration 0068 adds credited_amount).
      const alreadyCredited = Number.parseFloat(payable.creditedAmount ?? '0');
      const outstanding = totalAmt - alreadyPaid - alreadyCredited;

      if (amt > outstanding + 0.005) {
        throw new Error(
          `excede el saldo pendiente de la compra: outstanding ${outstanding.toFixed(2)}, requested ${amt.toFixed(2)}`,
        );
      }

      newPaidAmount = alreadyPaid + amt;
      // Status: paid when paid+credited >= total (both reduce the debt).
      payableStatus = newPaidAmount + alreadyCredited >= totalAmt - 0.005 ? 'paid' : 'partial';
    }

    // 5. INSERT treasury_movements salida — NO expenseId, NO category P&L.
    const [movement] = await tx
      .insert(treasuryMovementsSchema)
      .values({
        organizationId: input.organizationId,
        fromAccountId: input.fromAccountId,
        toAccountId: null,
        amount: toMoney(amt),
        type: 'salida',
        reason: input.note ?? 'Pago a proveedor',
        createdBy: input.createdBy,
      })
      .returning({ id: treasuryMovementsSchema.id });

    if (!movement) {
      throw new Error('treasury_movements: supplier payment insert returned no row');
    }

    // 6. INSERT supplier_payments — treasury_movement_id is NEVER null (REQ-4.2, migration 0066).
    const [payment] = await tx
      .insert(supplierPaymentsSchema)
      .values({
        organizationId: input.organizationId,
        supplierId: input.supplierId,
        payableId: input.payableId ?? null,
        treasuryMovementId: movement.id,
        amount: toMoney(amt),
        note: input.note ?? null,
        createdBy: input.createdBy,
      })
      .returning({ id: supplierPaymentsSchema.id });

    if (!payment) {
      throw new Error('supplier_payments: insert returned no row');
    }

    // 7. UPDATE supplier_payables: bump paid_amount + recompute status.
    if (input.payableId) {
      await tx
        .update(supplierPayablesSchema)
        .set({
          paidAmount: newPaidAmount.toFixed(2),
          status: payableStatus,
          updatedAt: new Date(),
        })
        .where(eq(supplierPayablesSchema.id, input.payableId));
    }

    return {
      paymentId: payment.id,
      treasuryMovementId: movement.id,
      payableStatus,
    };
  };

  // When executor is the top-level `db` singleton, open a dedicated transaction.
  // When executor is already a transaction object (e.g. a Drizzle tx passed from
  // a parent transaction, or a TenantDb tx proxy), call doWork directly — the
  // `.transaction` property is still present on a TenantDb tx (it exposes the
  // underlying Drizzle tx), so this check is NOT a reliable "is-standalone" test.
  // In practice, standalone callers pass the `db` singleton (has `.transaction`
  // as a function on the module), while callers inside a parent tx pass the tx
  // object directly and this branch is not reached. If a TenantDb tx is passed,
  // doWork nests a savepoint (harmless; rollback still propagates to the parent).
  const isRealDb = typeof (executor as { transaction?: unknown }).transaction === 'function';
  if (isRealDb) {
    return (executor as typeof import('@/libs/DB').db).transaction(
      tx => doWork(tx as unknown as Executor),
    );
  }
  return doWork(executor);
}
