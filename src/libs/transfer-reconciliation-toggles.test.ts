/**
 * PR6 — Org toggles + close-block guard lib tests (Strict TDD — RED first)
 *
 * Scenarios covered:
 *   S-16: Toggle A OFF — hasOpenInvestigations returns false even with not_arrived rows
 *         (no block-close when toggle is off)
 *   S-17: Toggle A ON — hasOpenInvestigations returns true when not_arrived rows exist
 *   S-18: Toggle A ON — hasOpenInvestigations returns false when no not_arrived rows
 *   S-19: Toggle B default (investigate) — getDefaultResolution returns 'investigate'
 *   S-20: Toggle B direct_loss — getDefaultResolution returns 'direct_loss'
 *   S-21: (covered at action layer) — recovery still possible after direct_loss
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BLOCK_CLOSE_SETTING_KEY,
  DEFAULT_RESOLUTION_SETTING_KEY,
  getBlockCloseOnInvestigation,
  getDefaultResolution,
  hasOpenInvestigations,
} from '@/libs/transfer-reconciliation';

// ── PGlite schema ─────────────────────────────────────────────────────────────

// Extract Executor from the first param of hasOpenInvestigations — same pattern
// used in transfer-reconciliation.test.ts:21.
type Executor = Parameters<typeof hasOpenInvestigations>[0];

const ENUMS = [
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch', 'resolved')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability')`,
];

const DDL = `
  CREATE TABLE transfer_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    sale_payment_id uuid,
    pos_token_id uuid,
    cash_session_id uuid,
    method text NOT NULL,
    expected_amount numeric(12, 2) NOT NULL,
    arrived_amount numeric(12, 2),
    reference text,
    status "transfer_reconciliation_status" DEFAULT 'pending' NOT NULL,
    reconciled_by text,
    reconciled_at timestamp,
    note text,
    resolution_type "transfer_resolution_type",
    resolved_by text,
    resolved_at timestamp,
    resolution_credito_id uuid,
    claim_open boolean DEFAULT false NOT NULL,
    recovery_of_id uuid,
    remainder_reconciliation_id uuid,
    cashier_explanation text,
    cashier_explained_by text,
    cashier_explained_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX transfer_reconciliations_sale_payment_idx
    ON transfer_reconciliations (sale_payment_id)
    WHERE sale_payment_id IS NOT NULL;

  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );
`;

let pg: PGlite;
let db: Executor;

const ORG = 'org-toggles-test';
let counter = 0;
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

async function seedNotArrived(): Promise<string> {
  counter++;
  const id = UUID(counter);
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status)
     VALUES ($1, $2, 'Transferencia', '100.00', 'not_arrived')`,
    [id, ORG],
  );
  return id;
}

async function seedResolved(): Promise<string> {
  counter++;
  const id = UUID(counter);
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status, resolution_type,
        resolved_by, resolved_at)
     VALUES ($1, $2, 'Transferencia', '100.00', 'resolved', 'loss',
             'admin', now())`,
    [id, ORG],
  );
  return id;
}

async function setSetting(key: string, value: string): Promise<void> {
  await pg.query(
    `INSERT INTO app_settings (organization_id, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = $3`,
    [ORG, key, value],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
  db = drizzle(pg) as unknown as Executor;
});

beforeEach(async () => {
  await pg.exec(
    'DELETE FROM transfer_reconciliations; DELETE FROM app_settings;',
  );
  counter = 0;
});

// ── Setting key constants ─────────────────────────────────────────────────────

describe('setting key constants', () => {
  it('BLOCK_CLOSE_SETTING_KEY is the expected string', () => {
    expect(BLOCK_CLOSE_SETTING_KEY).toBe('transfer-block-close-on-investigation');
  });

  it('DEFAULT_RESOLUTION_SETTING_KEY is the expected string', () => {
    expect(DEFAULT_RESOLUTION_SETTING_KEY).toBe('transfer-default-resolution');
  });
});

// ── hasOpenInvestigations ─────────────────────────────────────────────────────

describe('hasOpenInvestigations', () => {
  it('S-16a: returns false when no not_arrived rows exist', async () => {
    const result = await hasOpenInvestigations(db, ORG);

    expect(result).toBe(false);
  });

  it('S-16b: returns false when only resolved rows exist (not not_arrived)', async () => {
    await seedResolved();

    const result = await hasOpenInvestigations(db, ORG);

    expect(result).toBe(false);
  });

  it('S-17: returns true when at least one not_arrived row exists', async () => {
    await seedNotArrived();

    const result = await hasOpenInvestigations(db, ORG);

    expect(result).toBe(true);
  });

  it('S-18: returns false when not_arrived rows exist for OTHER org only', async () => {
    counter++;
    const id = UUID(counter);
    await pg.query(
      `INSERT INTO transfer_reconciliations
         (id, organization_id, method, expected_amount, status)
       VALUES ($1, 'OTHER-ORG', 'Transferencia', '100.00', 'not_arrived')`,
      [id],
    );

    const result = await hasOpenInvestigations(db, ORG);

    expect(result).toBe(false);
  });

  it('uses LIMIT 1 semantics — still true even with many not_arrived rows', async () => {
    await seedNotArrived();
    await seedNotArrived();
    await seedNotArrived();

    const result = await hasOpenInvestigations(db, ORG);

    expect(result).toBe(true);
  });
});

// ── getBlockCloseOnInvestigation ──────────────────────────────────────────────

describe('getBlockCloseOnInvestigation', () => {
  it('returns false when setting is absent (default OFF)', async () => {
    const result = await getBlockCloseOnInvestigation(db, ORG);

    expect(result).toBe(false);
  });

  it('returns false when setting value is empty string', async () => {
    await setSetting(BLOCK_CLOSE_SETTING_KEY, '');

    const result = await getBlockCloseOnInvestigation(db, ORG);

    expect(result).toBe(false);
  });

  it('returns true when setting is "true"', async () => {
    await setSetting(BLOCK_CLOSE_SETTING_KEY, 'true');

    const result = await getBlockCloseOnInvestigation(db, ORG);

    expect(result).toBe(true);
  });

  it('returns false when setting is "false"', async () => {
    await setSetting(BLOCK_CLOSE_SETTING_KEY, 'false');

    const result = await getBlockCloseOnInvestigation(db, ORG);

    expect(result).toBe(false);
  });
});

// ── getDefaultResolution ─────────────────────────────────────────────────────

describe('getDefaultResolution', () => {
  it('S-19: returns "investigate" when setting is absent (default)', async () => {
    const result = await getDefaultResolution(db, ORG);

    expect(result).toBe('investigate');
  });

  it('S-19: returns "investigate" when setting is empty string', async () => {
    await setSetting(DEFAULT_RESOLUTION_SETTING_KEY, '');

    const result = await getDefaultResolution(db, ORG);

    expect(result).toBe('investigate');
  });

  it('S-19: returns "investigate" when setting is explicitly "investigate"', async () => {
    await setSetting(DEFAULT_RESOLUTION_SETTING_KEY, 'investigate');

    const result = await getDefaultResolution(db, ORG);

    expect(result).toBe('investigate');
  });

  it('S-20: returns "direct_loss" when setting is "direct_loss"', async () => {
    await setSetting(DEFAULT_RESOLUTION_SETTING_KEY, 'direct_loss');

    const result = await getDefaultResolution(db, ORG);

    expect(result).toBe('direct_loss');
  });
});
