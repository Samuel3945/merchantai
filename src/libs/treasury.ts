import type { db } from '@/libs/DB';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  computeCashBreakdown,
  findOpenSession,
  getOpeningExpected,
  toMoney,
} from '@/libs/cash-helpers';
import {
  appSettingsSchema,
  cashMovementsSchema,
  cashSessionsSchema,
  expensesSchema,
  paymentMethodsSchema,
  posTokensSchema,
  transferReconciliationsSchema,
  treasuryAccountsSchema,
  treasuryMovementsSchema,
  treasuryTransfersSchema,
} from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TreasuryAccountType = 'caja' | 'caja_fuerte' | 'banco' | 'transito';

export type TreasuryAccount = {
  key: string;
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

  // Cajas POS — one drawer per device. UNCHANGED from Phase 1.
  const tokens = await executor
    .select({ id: posTokensSchema.id, name: posTokensSchema.deviceName })
    .from(posTokensSchema)
    .where(eq(posTokensSchema.organizationId, organizationId));

  // Batch-fetch the most recent closed session ID per pos_token (for R7 "entregado" label).
  // One query for all tokens avoids N+1. Result: Map<posTokenId, sessionId>.
  const lastSessionIds = new Map<string, string>();
  if (tokens.length > 0) {
    const sessionRows = await executor
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
            AND pos_token_id IS NOT NULL
          ORDER BY pos_token_id, closed_at DESC
        ) latest_sessions`,
      );
    for (const r of sessionRows) {
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
    tokens.map(async (t) => {
      const sessionId = lastSessionIds.get(t.id);
      const balance = await cajaBalance(executor, organizationId, t.id);
      return {
        key: `caja:${t.id}`,
        name: t.name,
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
// lives in cajas/caja_fuerte, or fiado, which is a debt). Each of these gets a
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

  // Compute current balance for the source container.
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

  const doInserts = async (tx: Executor): Promise<string> => {
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

  // When executor is the real `db`, wrap in a transaction for atomicity.
  // When executor is already a tx (passed from a parent transaction), use it directly.
  const isRealDb = typeof (executor as { transaction?: unknown }).transaction === 'function';
  if (isRealDb) {
    return (executor as typeof import('@/libs/DB').db).transaction(tx => doInserts(tx as unknown as Executor));
  }
  return doInserts(executor);
}

// ── Phase 3 PR4: opt-in config flag ──────────────────────────────────────────

// treasury-sweep-model slice 2: TREASURY_HANDOVER_SETTING_KEY and
// getTreasuryHandoverEnabled removed. The at-close handover flag was retired in
// slice 1 (handoverBySession subtraction decoupled). Sweep destination config
// uses the new TREASURY_SWEEP_DEFAULT_KEY (resolveSweepDestination above).

// ── Slice 2: per-caja sweep destination resolver ─────────────────────────────

export const TREASURY_SWEEP_DEFAULT_KEY = 'treasurySweepDefaultDestinationAccountId';

export type SweepDestination = {
  accountId: string;
  isCofre: true;
};

/**
 * Resolves the auto-route destination for a caja's open-time sweep.
 * Priority: per-caja FK column → org-wide KV default → null (Pendiente).
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

  // 1. Per-caja column (highest priority)
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

  // 2. Org-wide KV default (fallback when no per-caja config)
  if (!candidateId) {
    const [kvRow] = await executor
      .select({ value: appSettingsSchema.value })
      .from(appSettingsSchema)
      .where(
        and(
          eq(appSettingsSchema.organizationId, organizationId),
          eq(appSettingsSchema.key, TREASURY_SWEEP_DEFAULT_KEY),
        ),
      )
      .limit(1);
    candidateId = kvRow?.value?.trim() || null;
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
export async function listTreasuryTimeline(
  executor: Executor,
  organizationId: string,
  limit = 100,
): Promise<TreasuryTimelineEntry[]> {
  // Fetch movements ordered newest-first.
  const movements = await executor
    .select({
      id: treasuryMovementsSchema.id,
      createdAt: treasuryMovementsSchema.createdAt,
      type: treasuryMovementsSchema.type,
      fromAccountId: treasuryMovementsSchema.fromAccountId,
      toAccountId: treasuryMovementsSchema.toAccountId,
      amount: treasuryMovementsSchema.amount,
    })
    .from(treasuryMovementsSchema)
    .where(eq(treasuryMovementsSchema.organizationId, organizationId))
    .orderBy(desc(treasuryMovementsSchema.createdAt))
    .limit(limit);

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
    origin: r.deviceName ?? 'Cierre de caja',
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
