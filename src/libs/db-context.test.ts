import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createTenantDb, db } from '@/libs/db-context';
import {
  customersSchema,
  productsSchema,
  saleItemsSchema,
} from '@/models/Schema';
import * as schema from '@/models/Schema';

// A `Pool` is constructed lazily — no connection happens until a query is
// executed. We never touch the network in these tests; we only inspect SQL
// via drizzle's `.toSQL()` helper.
function makeRawDb() {
  const pool = new Pool({ connectionString: 'postgres://x:x@127.0.0.1:1/x' });
  return drizzle({ client: pool, schema });
}

const ORG_A = 'org_2_aaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'org_2_bbbbbbbbbbbbbbbbbbbbbb';

describe('db-context tenant isolation', () => {
  describe('SELECT', () => {
    it('injects WHERE organization_id = orgA on bare select', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);
      const q = t.select().from(productsSchema);
      const { sql, params } = q.toSQL();

      expect(sql).toContain('"organization_id"');
      expect(params).toContain(ORG_A);
      expect(params).not.toContain(ORG_B);
    });

    it('ANDs the org filter with caller-supplied .where()', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);
      const q = t
        .select()
        .from(productsSchema)
        .where(eq(productsSchema.deleted, false));
      const { sql, params } = q.toSQL();

      // Both the org filter and the user filter survive.
      expect(sql).toMatch(/organization_id/);
      expect(sql).toMatch(/deleted/);
      expect(params).toContain(ORG_A);
    });

    it('keeps the org filter when the caller forges a different org in .where()', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);
      const q = t
        .select()
        .from(productsSchema)
        .where(eq(productsSchema.organizationId, ORG_B));
      const { params } = q.toSQL();

      // Caller's forged ORG_B is in the SQL but ANDed with ORG_A — the row
      // would have to belong to both orgs, which is impossible. No leak.
      expect(params).toContain(ORG_A);
      expect(params).toContain(ORG_B);
    });
  });

  describe('INSERT', () => {
    it('forces organization_id even when the caller omits it', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);
      const q = t
        .insert(productsSchema)
        .values({ name: 'X', price: '10' } as never);
      const { params } = q.toSQL();

      expect(params).toContain(ORG_A);
    });

    it('overrides a caller-supplied organization_id with the active org', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);
      const q = t
        .insert(productsSchema)
        .values({
          name: 'X',
          price: '10',
          organizationId: ORG_B,
        } as never);
      const { params } = q.toSQL();

      expect(params).toContain(ORG_A);
      expect(params).not.toContain(ORG_B);
    });

    it('rewrites organization_id on every row of a batch insert', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);
      const q = t.insert(productsSchema).values([
        { name: 'A', price: '1', organizationId: ORG_B },
        { name: 'B', price: '2' },
      ] as never);
      const { params } = q.toSQL();
      const orgAcount = params.filter(p => p === ORG_A).length;

      expect(orgAcount).toBe(2);
      expect(params).not.toContain(ORG_B);
    });
  });

  describe('UPDATE', () => {
    it('adds WHERE organization_id even when caller forges a foreign id', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);
      const q = t
        .update(productsSchema)
        .set({ name: 'changed' })
        .where(eq(productsSchema.id, 'some-uuid'));
      const { sql, params } = q.toSQL();

      expect(sql).toContain('organization_id');
      expect(params).toContain(ORG_A);
    });

    it('strips organization_id from `set` so callers cannot reassign tenant', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);
      const q = t
        .update(productsSchema)
        .set({ name: 'x', organizationId: ORG_B } as never);
      const { params } = q.toSQL();

      expect(params).not.toContain(ORG_B);
    });
  });

  describe('DELETE', () => {
    it('adds WHERE organization_id on bare delete', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);
      const q = t.delete(productsSchema);
      const { sql, params } = q.toSQL();

      expect(sql).toContain('organization_id');
      expect(params).toContain(ORG_A);
    });

    it('ANDs the org filter with a caller .where()', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);
      const q = t.delete(productsSchema).where(eq(productsSchema.id, 'some-uuid'));
      const { sql, params } = q.toSQL();

      expect(sql).toContain('organization_id');
      expect(params).toContain(ORG_A);
    });
  });

  describe('child tables', () => {
    it('refuses to .select() from sale_items directly', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);

      expect(() => t.select().from(saleItemsSchema)).toThrow(
        /child table 'sale_items'/,
      );
    });

    it('refuses to .insert() into sale_items directly', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);

      expect(() => t.insert(saleItemsSchema)).toThrow(/child table 'sale_items'/);
    });
  });

  describe('execute', () => {
    it('refuses raw .execute()', () => {
      const t = createTenantDb(makeRawDb(), ORG_A);

      expect(() => t.execute()).toThrow(/raw SQL bypasses tenant scoping/);
    });
  });

  describe('unsafeNoOrgFilter', () => {
    it('rejects empty or trivial justifications', () => {
      expect(() => db.unsafeNoOrgFilter('')).toThrow(/justification/);
      expect(() => db.unsafeNoOrgFilter('todo')).toThrow(/justification/);
      expect(() => db.unsafeNoOrgFilter('   ')).toThrow(/justification/);
    });

    it('accepts a meaningful justification', () => {
      const raw = db.unsafeNoOrgFilter(
        'cron job: recompute expiration risk cache for all orgs',
      );

      expect(raw).toBeTruthy();
      expect(typeof raw.select).toBe('function');
    });
  });

  describe('forOrg / forPosAuth', () => {
    it('forOrg requires a non-empty orgId', () => {
      expect(() => db.forOrg('')).toThrow(/orgId/);
    });

    it('forPosAuth requires organizationId on the ctx', () => {
      expect(() => db.forPosAuth({ organizationId: '' } as never)).toThrow(
        /organizationId/,
      );
    });

    it('forOrg scopes inserts to the requested tenant', () => {
      const t = db.forOrg(ORG_A, makeRawDb());
      const q = t
        .insert(customersSchema)
        .values({ name: 'X', organizationId: ORG_B } as never);
      const { params } = q.toSQL();

      expect(params).toContain(ORG_A);
      expect(params).not.toContain(ORG_B);
    });
  });

  describe('cross-org leak scenarios', () => {
    it('orgA SELECT cannot read orgB rows even if id is known', () => {
      const tA = createTenantDb(makeRawDb(), ORG_A);
      // Attacker tries: GET /api/products?id=<id-belonging-to-orgB>
      const q = tA
        .select()
        .from(productsSchema)
        .where(eq(productsSchema.id, 'orgB-product-uuid'));
      const { params } = q.toSQL();

      // The query carries orgA AND the requested id; orgB never appears.
      expect(params).toContain(ORG_A);
      expect(params).not.toContain(ORG_B);
    });

    it('orgA UPDATE cannot mutate orgB rows even if id is known', () => {
      const tA = createTenantDb(makeRawDb(), ORG_A);
      const q = tA
        .update(productsSchema)
        .set({ name: 'pwned' })
        .where(eq(productsSchema.id, 'orgB-product-uuid'));
      const { sql, params } = q.toSQL();

      expect(sql).toContain('organization_id');
      expect(params).toContain(ORG_A);
    });

    it('orgA DELETE cannot remove orgB rows even if id is known', () => {
      const tA = createTenantDb(makeRawDb(), ORG_A);
      const q = tA
        .delete(productsSchema)
        .where(eq(productsSchema.id, 'orgB-product-uuid'));
      const { sql, params } = q.toSQL();

      expect(sql).toContain('organization_id');
      expect(params).toContain(ORG_A);
    });
  });
});
