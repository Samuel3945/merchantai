import { PGlite } from '@electric-sql/pglite';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { usageCountersSchema } from '@/models/Schema';

// Integration test for the consumeCredit guarantee (actions/plans.ts). The AI
// credit decrement increments `used` only WHERE `used < monthly_limit +
// topped_up`, in a single atomic statement — so repeated/concurrent consumption
// can never push usage past the org's purchased credits, and never go negative.
// The guarantee lives entirely in the SQL WHERE clause, so it is exercised here
// against a real Postgres engine (PGlite), mirroring consumeCredit's exact query.

type Db = ReturnType<typeof drizzle>;
let pg: PGlite;
let db: Db;

const DDL = `
  CREATE TABLE usage_counters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    agent_kind text NOT NULL,
    used integer DEFAULT 0 NOT NULL,
    monthly_limit integer DEFAULT 0 NOT NULL,
    topped_up integer DEFAULT 0 NOT NULL,
    reset_at timestamp
  );
`;

const ORG = 'org-test';
const KIND = 'sales_manager';

// The exact conditional decrement consumeCredit runs. Returns true when a credit
// was consumed (a row matched and was updated), false when none remained.
async function consume(): Promise<boolean> {
  const updated = await db
    .update(usageCountersSchema)
    .set({ used: sql`${usageCountersSchema.used} + 1` })
    .where(
      and(
        eq(usageCountersSchema.organizationId, ORG),
        eq(usageCountersSchema.agentKind, KIND),
        sql`${usageCountersSchema.used} < ${usageCountersSchema.monthlyLimit} + ${usageCountersSchema.toppedUp}`,
      ),
    )
    .returning({ used: usageCountersSchema.used });
  return updated.length > 0;
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Db;
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM usage_counters');
});

describe('consumeCredit credit guarantee', () => {
  it('allows exactly monthly_limit + topped_up consumptions, then refuses', async () => {
    await db.insert(usageCountersSchema).values({
      organizationId: ORG,
      agentKind: KIND,
      used: 0,
      monthlyLimit: 2,
      toppedUp: 1,
    });

    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await consume());
    }

    // 3 credits available (2 monthly + 1 topped up); the 4th and 5th are refused.
    expect(results).toEqual([true, true, true, false, false]);

    const [row] = await db.select().from(usageCountersSchema);

    expect(row?.used).toBe(3);
  });

  it('refuses immediately when already at the limit (never goes over)', async () => {
    await db.insert(usageCountersSchema).values({
      organizationId: ORG,
      agentKind: KIND,
      used: 5,
      monthlyLimit: 5,
      toppedUp: 0,
    });

    expect(await consume()).toBe(false);

    const [row] = await db.select().from(usageCountersSchema);

    expect(row?.used).toBe(5);
  });

  it('never consumes another org\'s credits', async () => {
    await db.insert(usageCountersSchema).values({
      organizationId: 'other-org',
      agentKind: KIND,
      used: 0,
      monthlyLimit: 10,
      toppedUp: 0,
    });

    // ORG has no counter row of its own, so nothing is consumed.
    expect(await consume()).toBe(false);

    const [row] = await db.select().from(usageCountersSchema);

    expect(row?.used).toBe(0);
  });
});
