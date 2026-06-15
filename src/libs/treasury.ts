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
  posTokensSchema,
  transferReconciliationsSchema,
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

// Phase 1 treasury position, DERIVED from existing data — no new tables, no flow
// changes. It surfaces what used to be invisible: the safe (accumulated security
// withdrawals) and each bank account (transfers that actually landed).
export async function getTreasuryPosition(
  executor: Executor,
  organizationId: string,
): Promise<TreasuryAccount[]> {
  const accounts: TreasuryAccount[] = [];

  // Cajas POS — one drawer per device.
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

  // The office drawer — movements made from the panel (no device).
  accounts.push({
    key: 'caja:oficina',
    name: 'Caja oficina',
    type: 'caja',
    balance: await cajaBalance(executor, organizationId, null),
  });

  // Treasury ledger (inter-container transfers — first use: consignaciones
  // Caja Fuerte → Banco).
  const transfers = await executor
    .select({
      from: treasuryTransfersSchema.fromAccount,
      to: treasuryTransfersSchema.toAccount,
      sum: sql<string>`COALESCE(SUM(${treasuryTransfersSchema.amount}), 0)::text`,
    })
    .from(treasuryTransfersSchema)
    .where(eq(treasuryTransfersSchema.organizationId, organizationId))
    .groupBy(treasuryTransfersSchema.fromAccount, treasuryTransfersSchema.toAccount);

  // Caja fuerte — now EXACT: security withdrawals in, consignaciones out.
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
  const consignado = transfers
    .filter(t => t.from === 'caja_fuerte')
    .reduce((s, t) => s + (Number.parseFloat(t.sum) || 0), 0);
  accounts.push({
    key: 'caja_fuerte',
    name: 'Caja fuerte',
    type: 'caja_fuerte',
    balance: Number.parseFloat((withdrawn - consignado).toFixed(2)),
  });

  // Bancos — transfers that landed (confirmed + mismatch) PLUS consignaciones
  // received from the safe, grouped by account/method.
  const bankRows = await executor
    .select({
      method: transferReconciliationsSchema.method,
      sum: sql<string>`COALESCE(SUM(COALESCE(${transferReconciliationsSchema.arrivedAmount}, ${transferReconciliationsSchema.expectedAmount})), 0)::text`,
    })
    .from(transferReconciliationsSchema)
    .where(
      and(
        eq(transferReconciliationsSchema.organizationId, organizationId),
        sql`${transferReconciliationsSchema.status} IN ('confirmed', 'mismatch')`,
      ),
    )
    .groupBy(transferReconciliationsSchema.method);
  const bankMap = new Map<string, number>();
  for (const b of bankRows) {
    bankMap.set(b.method, Number.parseFloat(b.sum) || 0);
  }
  for (const t of transfers) {
    if (t.to.startsWith('banco:')) {
      const method = t.to.slice('banco:'.length);
      bankMap.set(
        method,
        Number.parseFloat(
          ((bankMap.get(method) ?? 0) + (Number.parseFloat(t.sum) || 0)).toFixed(2),
        ),
      );
    }
  }
  for (const [method, balance] of bankMap) {
    accounts.push({ key: `banco:${method}`, name: method, type: 'banco', balance });
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
