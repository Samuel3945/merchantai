import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findOrCreateCustomer } from '@/libs/customers';
import { customersSchema } from '@/models/Schema';

// ── PGlite-backed tests for findOrCreateCustomer (PR3 — S-05, S-05b) ─────────
//
// ADR-7: dedup strategy is whatsapp-first, then documentId, else create.
// The `customers` table has partial unique indexes on (org, whatsapp) WHERE
// whatsapp IS NOT NULL AND deleted=false and (org, documentId) WHERE
// documentId IS NOT NULL AND deleted=false.
//
// TDD (Strict): tests were written RED before the implementation.

type Executor = Parameters<typeof findOrCreateCustomer>[0];

let pg: PGlite;
let db: Executor;

// No custom ENUMS needed — customers table has no enum columns.

const DDL = `
  CREATE TABLE customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    document_id text,
    whatsapp text,
    email text,
    address text,
    notes text,
    marketing_opt_in boolean DEFAULT true NOT NULL,
    total_spent numeric(14, 2) DEFAULT '0' NOT NULL,
    last_purchase_at timestamp,
    created_by text,
    deleted boolean DEFAULT false NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX customers_org_document_unique_idx
    ON customers (organization_id, document_id)
    WHERE document_id IS NOT NULL AND deleted = false;

  CREATE UNIQUE INDEX customers_org_whatsapp_unique_idx
    ON customers (organization_id, whatsapp)
    WHERE whatsapp IS NOT NULL AND deleted = false;
`;

const ORG = 'org-cust-test';
const USER = 'test-user';

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Executor;
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM customers');
});

// ── S-05: creates a new customer when no match exists ────────────────────────

describe('findOrCreateCustomer — create path', () => {
  it('creates a new customer row when no matching whatsapp or document exists', async () => {
    const result = await findOrCreateCustomer(db, {
      orgId: ORG,
      name: 'Ana García',
      whatsapp: '3001234567',
      createdBy: USER,
    });

    expect(result.id).toBeTruthy();
    expect(result.name).toBe('Ana García');

    const [row] = await db
      .select()
      .from(customersSchema)
      .where(eq(customersSchema.id, result.id));

    expect(row).toBeDefined();
    expect(row?.organizationId).toBe(ORG);
    expect(row?.name).toBe('Ana García');
    expect(row?.whatsapp).toBe('3001234567');
    expect(row?.deleted).toBe(false);
  });

  it('creates a customer with documentId when no whatsapp provided', async () => {
    const result = await findOrCreateCustomer(db, {
      orgId: ORG,
      name: 'Pedro López',
      documentId: '12345678',
      createdBy: USER,
    });

    expect(result.id).toBeTruthy();

    const [row] = await db
      .select()
      .from(customersSchema)
      .where(eq(customersSchema.id, result.id));

    expect(row?.documentId).toBe('12345678');
    expect(row?.whatsapp).toBeNull();
  });

  it('creates a customer with name only when no contact info provided', async () => {
    const result = await findOrCreateCustomer(db, {
      orgId: ORG,
      name: 'Sin Contacto',
      createdBy: USER,
    });

    expect(result.id).toBeTruthy();

    const rows = await db
      .select()
      .from(customersSchema)
      .where(eq(customersSchema.organizationId, ORG));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Sin Contacto');
  });
});

// ── S-05b: dedup — match on whatsapp first ───────────────────────────────────

describe('findOrCreateCustomer — dedup on whatsapp', () => {
  it('returns the existing customer when whatsapp already exists in org', async () => {
    // Pre-existing customer with same whatsapp
    const [existing] = await db
      .insert(customersSchema)
      .values({
        organizationId: ORG,
        name: 'Ana García',
        whatsapp: '3001234567',
        deleted: false,
        createdBy: USER,
      })
      .returning();

    const result = await findOrCreateCustomer(db, {
      orgId: ORG,
      name: 'Ana García Duplicada',
      whatsapp: '3001234567',
      createdBy: USER,
    });

    // Must return the EXISTING customer, not create a duplicate
    expect(result.id).toBe(existing!.id);

    const allRows = await db
      .select()
      .from(customersSchema)
      .where(eq(customersSchema.organizationId, ORG));

    expect(allRows).toHaveLength(1);
  });

  it('does NOT dedup on name alone — creates a new row for same name different contact', async () => {
    await db.insert(customersSchema).values({
      organizationId: ORG,
      name: 'Carlos Rodríguez',
      whatsapp: '3001111111',
      deleted: false,
      createdBy: USER,
    });

    const result = await findOrCreateCustomer(db, {
      orgId: ORG,
      name: 'Carlos Rodríguez',
      whatsapp: '3002222222',
      createdBy: USER,
    });

    const allRows = await db
      .select()
      .from(customersSchema)
      .where(eq(customersSchema.organizationId, ORG));

    // Two separate customers (homonyms are valid)
    expect(allRows).toHaveLength(2);
    // The new row has a different id
    expect(result.id).not.toBe(allRows[0]?.id);
  });
});

// ── S-05b: dedup — fall back to documentId when no whatsapp ─────────────────

describe('findOrCreateCustomer — dedup on documentId', () => {
  it('returns the existing customer when documentId matches and no whatsapp provided', async () => {
    const [existing] = await db
      .insert(customersSchema)
      .values({
        organizationId: ORG,
        name: 'María Torres',
        documentId: '99887766',
        deleted: false,
        createdBy: USER,
      })
      .returning();

    const result = await findOrCreateCustomer(db, {
      orgId: ORG,
      name: 'María Torres (call)',
      documentId: '99887766',
      createdBy: USER,
    });

    expect(result.id).toBe(existing!.id);

    const allRows = await db
      .select()
      .from(customersSchema)
      .where(eq(customersSchema.organizationId, ORG));

    expect(allRows).toHaveLength(1);
  });
});

// ── FIX 5: documentId collision when whatsapp is new ─────────────────────────
// When BOTH whatsapp and documentId are provided and only the documentId already
// exists (new whatsapp), the insert hits the documentId unique index and
// onConflictDoNothing returns no row. The re-select must then match on whatsapp
// OR documentId — keying on whatsapp alone finds nothing and throws (latent 500).

describe('findOrCreateCustomer — documentId collision with a new whatsapp', () => {
  it('returns the existing row when documentId collides but whatsapp is new', async () => {
    const [existing] = await db
      .insert(customersSchema)
      .values({
        organizationId: ORG,
        name: 'Documento Existente',
        documentId: '55667788',
        whatsapp: null,
        deleted: false,
        createdBy: USER,
      })
      .returning();

    // Same documentId, a brand-new whatsapp → conflict fires on the document
    // index, not the whatsapp one.
    const result = await findOrCreateCustomer(db, {
      orgId: ORG,
      name: 'Documento Existente (otro contacto)',
      whatsapp: '3007778888',
      documentId: '55667788',
      createdBy: USER,
    });

    expect(result.id).toBe(existing!.id);

    // No duplicate created.
    const allRows = await db
      .select()
      .from(customersSchema)
      .where(eq(customersSchema.organizationId, ORG));

    expect(allRows).toHaveLength(1);
  });
});

// ── Org isolation: does NOT dedup across organizations ───────────────────────

describe('findOrCreateCustomer — org isolation', () => {
  it('creates a new row when the same whatsapp exists in a DIFFERENT org', async () => {
    await db.insert(customersSchema).values({
      organizationId: 'org-other',
      name: 'Same WhatsApp',
      whatsapp: '3005555555',
      deleted: false,
      createdBy: USER,
    });

    const result = await findOrCreateCustomer(db, {
      orgId: ORG,
      name: 'Same WhatsApp',
      whatsapp: '3005555555',
      createdBy: USER,
    });

    // Should create a NEW row for ORG
    const orgRows = await db
      .select()
      .from(customersSchema)
      .where(eq(customersSchema.organizationId, ORG));

    expect(orgRows).toHaveLength(1);
    expect(result.id).toBe(orgRows[0]?.id);
  });
});

// ── Deleted customer: does NOT match a soft-deleted row ──────────────────────

describe('findOrCreateCustomer — ignores soft-deleted rows', () => {
  it('creates a new customer when existing row with same whatsapp is deleted', async () => {
    await db.insert(customersSchema).values({
      organizationId: ORG,
      name: 'Deleted User',
      whatsapp: '3009999999',
      deleted: true,
      createdBy: USER,
    });

    const result = await findOrCreateCustomer(db, {
      orgId: ORG,
      name: 'New User',
      whatsapp: '3009999999',
      createdBy: USER,
    });

    // The partial unique index only covers WHERE deleted=false,
    // so a deleted row doesn't block insert — a new row is created.
    const allRows = await db
      .select()
      .from(customersSchema)
      .where(
        and(
          eq(customersSchema.organizationId, ORG),
          eq(customersSchema.deleted, false),
        ),
      );

    expect(allRows).toHaveLength(1);
    expect(allRows[0]?.id).toBe(result.id);
    expect(allRows[0]?.deleted).toBe(false);
  });
});
