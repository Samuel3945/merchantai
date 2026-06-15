import type { db } from '@/libs/DB';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  computeCashBreakdown,
  findOpenSession,
  toMoney,
} from '@/libs/cash-helpers';
import {
  cashMovementsSchema,
  cashSessionsSchema,
  expensesSchema,
  posTokensSchema,
  transferReconciliationsSchema,
  treasuryAccountsSchema,
  treasuryMovementsSchema,
  treasuryTransfersSchema,
} from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TreasuryAccountType = 'caja' | 'caja_fuerte' | 'banco';

export type TreasuryAccount = {
  key: string;
  name: string;
  type: TreasuryAccountType;
  balance: number;
  note?: string;
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
  const [last] = await executor
    .select({ counted: cashSessionsSchema.countedAmount })
    .from(cashSessionsSchema)
    .where(
      and(
        eq(cashSessionsSchema.organizationId, organizationId),
        posTokenId === null
          ? isNull(cashSessionsSchema.posTokenId)
          : eq(cashSessionsSchema.posTokenId, posTokenId),
        eq(cashSessionsSchema.status, 'closed'),
      ),
    )
    .orderBy(desc(cashSessionsSchema.closedAt))
    .limit(1);
  return last ? Number.parseFloat(last.counted ?? '0') || 0 : 0;
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
  const cajas = await Promise.all(
    tokens.map(async t => ({
      key: `caja:${t.id}`,
      name: t.name,
      type: 'caja' as const,
      balance: await cajaBalance(executor, organizationId, t.id),
    })),
  );
  accounts.push(...cajas);

  // Office drawer — movements from the panel (no device). UNCHANGED from Phase 1.
  accounts.push({
    key: 'caja:oficina',
    name: 'Caja oficina',
    type: 'caja',
    balance: await cajaBalance(executor, organizationId, null),
  });

  // Vault (caja_fuerte) + banco accounts — READ FROM LEDGER (Phase 2C cutover).
  // Fetch all non-caja treasury_accounts for this org.
  const containerAccounts = await executor
    .select()
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.organizationId, organizationId),
        sql`${treasuryAccountsSchema.type} IN ('caja_fuerte', 'banco')`,
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
      accounts.push({
        key: acct.type === 'caja_fuerte' ? 'caja_fuerte' : `banco:${acct.name}`,
        name: acct.name,
        type: acct.type as TreasuryAccountType,
        balance: balanceForAccount(opening, credits, debits),
      });
    }
  }

  return accounts;
}

// Records a consignación: cash physically moved from the safe to a bank account.
// Lowers caja fuerte, raises the bank — a real inter-container transfer.
export async function recordConsignacion(
  executor: Executor,
  args: {
    organizationId: string;
    toBankMethod: string;
    amount: number | string;
    note?: string | null;
    createdBy: string;
  },
): Promise<void> {
  await executor.insert(treasuryTransfersSchema).values({
    organizationId: args.organizationId,
    fromAccount: 'caja_fuerte',
    toAccount: `banco:${args.toBankMethod}`,
    amount: toMoney(args.amount),
    note: args.note ?? null,
    createdBy: args.createdBy,
  });
}

// ── 2A: treasury_accounts CRUD ────────────────────────────────────────────────

export type TreasuryAccountRow = typeof treasuryAccountsSchema.$inferSelect;

export type CreateTreasuryAccountInput = {
  organizationId: string;
  type: 'caja' | 'caja_fuerte' | 'banco';
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

  const [row] = await executor
    .insert(treasuryMovementsSchema)
    .values({
      organizationId: input.organizationId,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amount: toMoney(amt),
      type: 'transfer',
      reason: input.reason ?? null,
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
};

/**
 * Records a consignación (cash → banco) in the treasury_movements ledger.
 * The source container (caja or caja_fuerte) must be active and have sufficient
 * balance. The destination banco account must also be active.
 *
 * NOTE: consignarABanco (the legacy treasury_transfers writer) is kept in
 * src/actions/treasury.ts as a thin fallback wrapper and is retired in Phase 2D.
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

  const [row] = await executor
    .insert(treasuryMovementsSchema)
    .values({
      organizationId: input.organizationId,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toBankAccountId,
      amount: toMoney(amt),
      type: 'consignacion',
      reason: input.note ?? null,
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
