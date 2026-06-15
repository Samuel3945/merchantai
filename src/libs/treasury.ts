import type { db } from '@/libs/DB';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { computeCashBreakdown, findOpenSession } from '@/libs/cash-helpers';
import {
  cashMovementsSchema,
  cashSessionsSchema,
  posTokensSchema,
  transferReconciliationsSchema,
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

  // Caja fuerte — accumulated security withdrawals. Approximate until Phase 2
  // tracks consignaciones out; the note keeps it from reading as exact.
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
  accounts.push({
    key: 'caja_fuerte',
    name: 'Caja fuerte',
    type: 'caja_fuerte',
    balance: Number.parseFloat(safe?.sum ?? '0') || 0,
    note: 'Retirado a seguridad (acumulado)',
  });

  // Bancos — transfer money that actually landed (confirmed + mismatch carry an
  // arrived amount), grouped by account/method.
  const banks = await executor
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
  for (const b of banks) {
    accounts.push({
      key: `banco:${b.method}`,
      name: b.method,
      type: 'banco',
      balance: Number.parseFloat(b.sum) || 0,
    });
  }

  return accounts;
}
