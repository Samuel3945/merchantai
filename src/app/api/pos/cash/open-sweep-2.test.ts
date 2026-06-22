/**
 * Slice 2 — Per-caja Sweep Destination Config + Auto-route (Strict TDD, RED phase)
 *
 * Tests validate:
 *   (a) Configured cofre → open-time shortfall auto-routes to cofre (no transito)
 *   (b) Unconfigured caja → falls back to Pendiente de ubicar (slice-1 path)
 *   (e) Cofre-only guard: config action rejects banco/caja/transito as destination
 *   (f) Destination inactive/deleted at open → fallback to Pendiente (not a throw)
 *   (g) Auto-routed sweep is reclassifiable (reclassifyAutoSweep action)
 *   (h) ON DELETE SET NULL: deleting the cofre account clears the FK on pos_tokens
 *   (i) resolveSweepDestination: per-caja → null priority
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTreasuryPosition, resolveSweepDestination } from '@/libs/treasury';
import { POST } from './open/route';

type TreasuryExecutor = Parameters<typeof resolveSweepDestination>[0];

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  authCtx: null as Record<string, unknown> | null,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));
vi.mock('@/libs/pos-auth', () => ({
  requirePosAuth: vi.fn(async () => ({ ctx: h.authCtx, errorResponse: null })),
}));
vi.mock('@/libs/audit-log', async importOriginal => ({
  ...(await importOriginal<typeof import('@/libs/audit-log')>()),
  logAction: vi.fn(async () => {}),
}));
vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({
    userId: 'user_test',
    orgId: 'org_sweep2_test',
    orgRole: 'org:admin',
  })),
  currentUser: vi.fn(async () => ({ fullName: 'Test Owner' })),
}));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const ORG = 'org_sweep2_test';
const TOKEN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COFRE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BANCO_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TRANSITO_ACCOUNT_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

// Full DDL — must include default_sweep_destination_account_id (drizzle_pglite_test_ddl_gotcha)
// Order: treasury_accounts first (pos_tokens FKs to it), then other tables.
const SCHEMA = `
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');
  CREATE TYPE "treasury_account_type" AS ENUM('caja','caja_fuerte','banco','transito');
  CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment','handover');

  CREATE TABLE treasury_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    type "treasury_account_type" NOT NULL,
    name text NOT NULL,
    opening_balance numeric(12,2) DEFAULT '0' NOT NULL,
    active boolean DEFAULT true NOT NULL,
    payment_method_id uuid,
    pos_token_id uuid,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT treasury_accounts_org_name_unique UNIQUE (organization_id, name)
  );

  CREATE TABLE pos_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    device_name text NOT NULL,
    allow_oversell boolean DEFAULT false NOT NULL,
    default_sweep_destination_account_id uuid REFERENCES treasury_accounts(id) ON DELETE SET NULL
  );

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
    notes text,
    opening_expected numeric(12, 2),
    opening_difference numeric(12, 2),
    opening_explanation text
  );

  CREATE TABLE treasury_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    from_account_id uuid,
    to_account_id uuid,
    amount numeric(12,2) NOT NULL,
    type "treasury_movement_type" NOT NULL,
    category text,
    reason text,
    expense_id uuid,
    transfer_reconciliation_id uuid,
    handover_movement_id uuid,
    cash_session_id uuid,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT treasury_mov_one_external CHECK (
      num_nonnulls(from_account_id, to_account_id) = 2
      OR (
        num_nonnulls(from_account_id, to_account_id) = 1
        AND type IN ('entrada', 'salida', 'gasto', 'consignacion', 'adjustment', 'handover')
      )
    )
  );

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    organization_id text NOT NULL,
    type text NOT NULL,
    amount numeric(12, 2) NOT NULL,
    reason text NOT NULL,
    created_by text NOT NULL,
    origin text,
    treasury_movement_id uuid,
    expense_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );
`;

let pg: PGlite;

async function seedClosedSession(counted: string, sessionId: string): Promise<void> {
  await pg.query(
    `INSERT INTO cash_sessions
       (id, organization_id, pos_token_id, opened_by, opening_amount, status,
        counted_amount, closed_at)
     VALUES ($1, $2, $3, 'cajero', '0', 'closed', $4, now())`,
    [sessionId, ORG, TOKEN, counted],
  );
}

async function seedCofre(id: string, active = true): Promise<void> {
  await pg.query(
    `INSERT INTO treasury_accounts (id, organization_id, type, name, opening_balance, active)
     VALUES ($1, $2, 'caja_fuerte', 'Bóveda principal', '0', $3)`,
    [id, ORG, active],
  );
}

async function seedBanco(id: string): Promise<void> {
  await pg.query(
    `INSERT INTO treasury_accounts (id, organization_id, type, name, opening_balance, active)
     VALUES ($1, $2, 'banco', 'Cuenta bancaria', '0', true)`,
    [id, ORG],
  );
}

function openRequest(body: unknown): Request {
  return new Request('http://localhost/api/pos/cash/open', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  // FK-safe order: children first, then parents
  await pg.exec('DELETE FROM treasury_movements');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM pos_tokens');
  await pg.exec('DELETE FROM treasury_accounts');
  await pg.exec('DELETE FROM app_settings');
  await pg.query(
    `INSERT INTO pos_tokens (id, organization_id, device_name) VALUES ($1, $2, 'Caja 1')`,
    [TOKEN, ORG],
  );
  h.authCtx = {
    organizationId: ORG,
    cashierName: 'Cajero',
    source: 'token',
    tokenId: TOKEN,
    cashierId: null,
  };
});

// ── (a) Configured cofre → auto-routes to cofre via two-step ─────────────────
// Design: handover → transito, then companion transfer transito → cofre in one tx.
// This keeps getRemainingForHandover=0 (fully placed, nothing in queue).

describe('POST /api/pos/cash/open — configured cofre auto-route (a)', () => {
  it('routes shortfall via transito → cofre in one tx; remaining=0', async () => {
    const CLOSED = '11111111-1111-1111-1111-111111111111';
    await seedClosedSession('500', CLOSED);
    await seedCofre(COFRE_ID);

    // Set the per-caja sweep destination to COFRE_ID
    await pg.query(
      `UPDATE pos_tokens SET default_sweep_destination_account_id = $1 WHERE id = $2`,
      [COFRE_ID, TOKEN],
    );

    const res = await POST(openRequest({ openingAmount: 400 }));

    expect(res.status).toBe(201);

    // A transito account must have been created (two-step requires it)
    const transitoRows = await pg.query<{ id: string }>(
      `SELECT id FROM treasury_accounts WHERE type = 'transito'`,
    );

    expect(transitoRows.rows.length).toBe(1);

    const transitoId = transitoRows.rows[0]!.id;

    // One handover row: from=NULL, to=transito
    const handover = await pg.query<{ id: string; to_account_id: string }>(
      `SELECT id, to_account_id FROM treasury_movements WHERE type = 'handover'`,
    );

    expect(handover.rows.length).toBe(1);
    expect(handover.rows[0]!.to_account_id).toBe(transitoId);

    // One transfer row: from=transito, to=cofre, handover_movement_id=handover.id
    const transfer = await pg.query<{
      from_account_id: string;
      to_account_id: string;
      handover_movement_id: string;
    }>(
      `SELECT from_account_id, to_account_id, handover_movement_id
         FROM treasury_movements WHERE type = 'transfer'`,
    );

    expect(transfer.rows.length).toBe(1);
    expect(transfer.rows[0]!.from_account_id).toBe(transitoId);
    expect(transfer.rows[0]!.to_account_id).toBe(COFRE_ID);
    expect(transfer.rows[0]!.handover_movement_id).toBe(handover.rows[0]!.id);

    // F3: money-conservation assertions
    const position = await getTreasuryPosition(h.db as unknown as TreasuryExecutor, ORG);
    const cofre = position.find(a => a.key.includes(COFRE_ID) || a.type === 'caja_fuerte');
    const transito2 = position.find(a => a.type === 'transito');

    // Company total conserved (500 counted at last close)
    const total = position.reduce((sum, a) => sum + a.balance, 0);

    expect(total).toBe(500);

    // Cofre holds the swept 100
    expect(cofre).toBeDefined();
    expect(cofre!.balance).toBe(100);

    // Transito nets to 0 (two-step: handover into transito, then immediately placed to cofre)
    expect(transito2).toBeDefined();
    expect(transito2!.balance).toBe(0);
  });
});

// ── (b) Unconfigured caja → falls back to Pendiente ──────────────────────────

describe('POST /api/pos/cash/open — unconfigured caja → Pendiente (b)', () => {
  it('routes shortfall to transito when no destination configured', async () => {
    const CLOSED = '22222222-2222-2222-2222-222222222222';
    await seedClosedSession('500', CLOSED);

    // No sweep destination set on pos_tokens

    const res = await POST(openRequest({ openingAmount: 400 }));

    expect(res.status).toBe(201);

    const transito = await pg.query(
      `SELECT 1 FROM treasury_accounts WHERE type = 'transito'`,
    );

    expect(transito.rows.length).toBe(1);

    const movements = await pg.query(
      `SELECT 1 FROM treasury_movements WHERE type = 'handover'`,
    );

    expect(movements.rows.length).toBe(1);

    // No transfer should exist (still in transito/pending)
    const transfers = await pg.query(
      `SELECT 1 FROM treasury_movements WHERE type = 'transfer'`,
    );

    expect(transfers.rows.length).toBe(0);
  });
});

// ── (c) Global default applies when caja column is null ──────────────────────

// ── (e) Cofre-only guard ───────────────────────────────────────────────────────

describe('resolveSweepDestination — cofre-only guard (e)', () => {
  it('returns null for a banco account (bank is not a valid auto-sweep target)', async () => {
    await seedBanco(BANCO_ID);

    // Set banco as the pos_token config (invalid)
    await pg.query(
      `UPDATE pos_tokens SET default_sweep_destination_account_id = $1 WHERE id = $2`,
      [BANCO_ID, TOKEN],
    );

    const result = await resolveSweepDestination(h.db as unknown as TreasuryExecutor, ORG, TOKEN);

    // Should return null — banco is not a valid cofre destination
    expect(result).toBeNull();
  });

  it('returns null for a transito account', async () => {
    await pg.query(
      `INSERT INTO treasury_accounts (id, organization_id, type, name, opening_balance, active)
       VALUES ($1, $2, 'transito', 'Pendiente de ubicar', '0', true)`,
      [TRANSITO_ACCOUNT_ID, ORG],
    );

    await pg.query(
      `UPDATE pos_tokens SET default_sweep_destination_account_id = $1 WHERE id = $2`,
      [TRANSITO_ACCOUNT_ID, TOKEN],
    );

    const result = await resolveSweepDestination(h.db as unknown as TreasuryExecutor, ORG, TOKEN);

    expect(result).toBeNull();
  });

  it('returns accountId for a valid active cofre', async () => {
    await seedCofre(COFRE_ID);

    await pg.query(
      `UPDATE pos_tokens SET default_sweep_destination_account_id = $1 WHERE id = $2`,
      [COFRE_ID, TOKEN],
    );

    const result = await resolveSweepDestination(h.db as unknown as TreasuryExecutor, ORG, TOKEN);

    expect(result).not.toBeNull();
    expect(result!.accountId).toBe(COFRE_ID);
    expect(result!.isCofre).toBe(true);
  });
});

// ── (f) Destination inactive at open → graceful fallback to Pendiente ─────────

describe('POST /api/pos/cash/open — inactive destination fallback (f)', () => {
  it('falls back to Pendiente when configured cofre is inactive', async () => {
    const CLOSED = '55555555-5555-5555-5555-555555555555';
    await seedClosedSession('500', CLOSED);
    await seedCofre(COFRE_ID, false); // inactive

    await pg.query(
      `UPDATE pos_tokens SET default_sweep_destination_account_id = $1 WHERE id = $2`,
      [COFRE_ID, TOKEN],
    );

    const res = await POST(openRequest({ openingAmount: 400 }));

    // Should succeed — graceful fallback
    expect(res.status).toBe(201);

    // Fallback: transito was created, no transfer
    const transito = await pg.query(
      `SELECT 1 FROM treasury_accounts WHERE type = 'transito'`,
    );

    expect(transito.rows.length).toBe(1);

    const transfers = await pg.query(
      `SELECT 1 FROM treasury_movements WHERE type = 'transfer'`,
    );

    expect(transfers.rows.length).toBe(0);
  });
});

// ── (g) Auto-routed sweep is reclassifiable ────────────────────────────────────

describe('reclassifyAutoSweep — auto-routed sweep can be re-routed (g)', () => {
  it('re-routes an auto-sweep from cofre A to cofre B', async () => {
    const { reclassifyAutoSweep } = await import('@/actions/treasury-placement');

    const CLOSED = '66666666-6666-6666-6666-666666666666';
    await seedClosedSession('500', CLOSED);

    const COFRE_A = 'aaaaaaaa-ffff-ffff-ffff-aaaaaaaaaaaa';
    const COFRE_B = 'bbbbbbbb-ffff-ffff-ffff-bbbbbbbbbbbb';
    await pg.query(
      `INSERT INTO treasury_accounts (id, organization_id, type, name, opening_balance, active)
       VALUES ($1, $2, 'caja_fuerte', 'Cofre A', '0', true), ($3, $2, 'caja_fuerte', 'Cofre B', '0', true)`,
      [COFRE_A, ORG, COFRE_B],
    );

    // Configure caja to route to COFRE_A
    await pg.query(
      `UPDATE pos_tokens SET default_sweep_destination_account_id = $1 WHERE id = $2`,
      [COFRE_A, TOKEN],
    );

    // Open with shortfall to trigger the auto-route
    const res = await POST(openRequest({ openingAmount: 400 }));

    expect(res.status).toBe(201);

    // Fetch the original transfer movement id
    const originalTransfer = await pg.query<{ id: string; to_account_id: string }>(
      `SELECT id, to_account_id FROM treasury_movements WHERE type = 'transfer'`,
    );

    expect(originalTransfer.rows.length).toBe(1);
    expect(originalTransfer.rows[0]!.to_account_id).toBe(COFRE_A);

    const originalTransferId = originalTransfer.rows[0]!.id;

    // Reclassify: re-route to COFRE_B
    const result = await reclassifyAutoSweep(originalTransferId, COFRE_B);

    expect(result.ok).toBe(true);

    // F4: conservation assertions after reclassify
    const position = await getTreasuryPosition(h.db as unknown as TreasuryExecutor, ORG);
    const cofreA = position.find(
      a => a.type === 'caja_fuerte' && a.key.includes(COFRE_A),
    );
    const cofreB = position.find(
      a => a.type === 'caja_fuerte' && a.key.includes(COFRE_B),
    );
    const transito2 = position.find(a => a.type === 'transito');

    // Cofre A ends at 0 (compensating return took the 100 back)
    expect(cofreA).toBeDefined();
    expect(cofreA!.balance).toBe(0);

    // Cofre B ends at the swept amount (100)
    expect(cofreB).toBeDefined();
    expect(cofreB!.balance).toBe(100);

    // Transito nets to 0 (return from A + forward to B cancel out)
    expect(transito2).toBeDefined();
    expect(transito2!.balance).toBe(0);
  });

  it('rejects a banco account as reclassify destination (F1 cofre-only guard)', async () => {
    const { reclassifyAutoSweep } = await import('@/actions/treasury-placement');

    const CLOSED = '77777777-7777-7777-7777-777777777777';
    await seedClosedSession('500', CLOSED);

    const COFRE_SRC = 'cccccccc-ffff-ffff-ffff-cccccccccccc';
    await pg.query(
      `INSERT INTO treasury_accounts (id, organization_id, type, name, opening_balance, active)
       VALUES ($1, $2, 'caja_fuerte', 'Cofre Src', '0', true)`,
      [COFRE_SRC, ORG],
    );
    await pg.query(
      `INSERT INTO treasury_accounts (id, organization_id, type, name, opening_balance, active)
       VALUES ($1, $2, 'banco', 'Banco Dest', '0', true)`,
      [BANCO_ID, ORG],
    );

    await pg.query(
      `UPDATE pos_tokens SET default_sweep_destination_account_id = $1 WHERE id = $2`,
      [COFRE_SRC, TOKEN],
    );

    const openRes = await POST(openRequest({ openingAmount: 400 }));

    expect(openRes.status).toBe(201);

    const originalTransfer = await pg.query<{ id: string }>(
      `SELECT id FROM treasury_movements WHERE type = 'transfer'`,
    );

    expect(originalTransfer.rows.length).toBe(1);

    const originalTransferId = originalTransfer.rows[0]!.id;

    // Attempt reclassify to banco — must be rejected
    const result = await reclassifyAutoSweep(originalTransferId, BANCO_ID);

    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error('Expected failure');
    }

    expect(result.error).toMatch(/caja[s ]?fuerte|cofre/i);
  });
});

// ── (h) ON DELETE SET NULL behavior ───────────────────────────────────────────

describe('pos_tokens.default_sweep_destination_account_id — ON DELETE SET NULL (h)', () => {
  it('clears the FK when the referenced treasury_account is deleted', async () => {
    await seedCofre(COFRE_ID);

    await pg.query(
      `UPDATE pos_tokens SET default_sweep_destination_account_id = $1 WHERE id = $2`,
      [COFRE_ID, TOKEN],
    );

    // Verify set
    const before = await pg.query<{ default_sweep_destination_account_id: string | null }>(
      `SELECT default_sweep_destination_account_id FROM pos_tokens WHERE id = $1`,
      [TOKEN],
    );

    expect(before.rows[0]!.default_sweep_destination_account_id).toBe(COFRE_ID);

    // Delete the cofre
    await pg.query(`DELETE FROM treasury_accounts WHERE id = $1`, [COFRE_ID]);

    // FK should now be NULL (ON DELETE SET NULL)
    const after = await pg.query<{ default_sweep_destination_account_id: string | null }>(
      `SELECT default_sweep_destination_account_id FROM pos_tokens WHERE id = $1`,
      [TOKEN],
    );

    expect(after.rows[0]!.default_sweep_destination_account_id).toBeNull();
  });
});

// ── (i) resolveSweepDestination priority: per-caja → null ─────────────────────

describe('resolveSweepDestination — priority chain (i)', () => {
  it('returns null when nothing is configured', async () => {
    const result = await resolveSweepDestination(h.db as unknown as TreasuryExecutor, ORG, TOKEN);

    expect(result).toBeNull();
  });

  it('returns the per-caja FK destination when set', async () => {
    await seedCofre(COFRE_ID);

    await pg.query(
      `UPDATE pos_tokens SET default_sweep_destination_account_id = $1 WHERE id = $2`,
      [COFRE_ID, TOKEN],
    );

    const result = await resolveSweepDestination(h.db as unknown as TreasuryExecutor, ORG, TOKEN);

    expect(result).not.toBeNull();
    expect(result!.accountId).toBe(COFRE_ID);
  });
});
