import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  findCorrectableSession,
  recordCorrectionMovement,
} from '@/libs/cash-helpers';
import { cashSessionsSchema } from '@/models/Schema';

// ── PGlite-backed tests for post-close cash corrections (F4) ─────────────────

type Executor = Parameters<typeof findCorrectableSession>[0];

let pg: PGlite;
let db: Executor;

const ENUMS = [
  `CREATE TYPE "cash_session_status" AS ENUM('open', 'closed')`,
  `CREATE TYPE "cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment', 'advance', 'fiado_payment')`,
];

const DDL = `
  CREATE TABLE cash_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    opened_at timestamp DEFAULT now() NOT NULL,
    opened_by text NOT NULL,
    opening_amount numeric(12, 2) DEFAULT '0' NOT NULL,
    closed_at timestamp,
    closed_by text,
    expected_amount numeric(12, 2),
    counted_amount numeric(12, 2),
    difference numeric(12, 2),
    status "cash_session_status" DEFAULT 'open' NOT NULL,
    notes text
  );

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    type "cash_movement_type" NOT NULL,
    amount numeric(12, 2) NOT NULL,
    reason text NOT NULL,
    category text,
    authorized_by text,
    created_by text NOT NULL,
    sale_id uuid,
    supplier_id uuid,
    corrects_session_id uuid REFERENCES cash_sessions(id) ON DELETE SET NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

const ORG = 'org-1';
const OTHER = 'org-2';
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let counter = 0;

async function seedSession(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  counter++;
  const id = UUID(counter);
  await db.insert(cashSessionsSchema).values({
    id,
    organizationId: ORG,
    openedBy: 'owner',
    openingAmount: '0',
    status: 'open',
    ...overrides,
  } as any);
  return id;
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Executor;
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM cash_sessions');
  counter = 0;
});

describe('findCorrectableSession', () => {
  it('returns a closed session of the org', async () => {
    const id = await seedSession({ status: 'closed', closedAt: new Date() });
    const s = await findCorrectableSession(db, {
      sessionId: id,
      organizationId: ORG,
    });

    expect(s?.id).toBe(id);
  });

  it('returns undefined for an open session (you only correct a closed arqueo)', async () => {
    const id = await seedSession({ status: 'open' });
    const s = await findCorrectableSession(db, {
      sessionId: id,
      organizationId: ORG,
    });

    expect(s).toBeUndefined();
  });

  it('returns undefined for another org (tenant isolation)', async () => {
    const id = await seedSession({ status: 'closed', closedAt: new Date() });
    const s = await findCorrectableSession(db, {
      sessionId: id,
      organizationId: OTHER,
    });

    expect(s).toBeUndefined();
  });
});

describe('recordCorrectionMovement', () => {
  it('records an income correction (adjustment) referencing the closed session', async () => {
    const closed = await seedSession({ status: 'closed', closedAt: new Date() });
    const current = await seedSession({ status: 'open' });

    const m = await recordCorrectionMovement(db, {
      organizationId: ORG,
      originalSessionId: closed,
      currentSessionId: current,
      type: 'adjustment',
      amount: 20,
      reason: 'Apareció la plata que no había contado',
      createdBy: 'owner',
    });

    expect(m?.type).toBe('adjustment');
    expect(m?.sessionId).toBe(current);
    expect(m?.correctsSessionId).toBe(closed);
    expect(m?.amount).toBe('20.00');
  });

  it('records an outflow correction (expense) the owner chose', async () => {
    const closed = await seedSession({ status: 'closed', closedAt: new Date() });
    const current = await seedSession({ status: 'open' });

    const m = await recordCorrectionMovement(db, {
      organizationId: ORG,
      originalSessionId: closed,
      currentSessionId: current,
      type: 'expense',
      amount: 15,
      reason: 'Pagué un gasto en efectivo y no lo registré',
      createdBy: 'owner',
    });

    expect(m?.type).toBe('expense');
    expect(m?.correctsSessionId).toBe(closed);
    expect(m?.amount).toBe('15.00');
  });
});
