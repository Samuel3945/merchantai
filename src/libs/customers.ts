import type { Executor as FiadoExecutor } from '@/libs/fiados';
import { and, eq, or } from 'drizzle-orm';
import { customersSchema } from '@/models/Schema';

// Re-use the shared Executor type (db | tx) defined in fiados.ts which already
// covers the full Drizzle db/tx union. Importing it keeps customers.ts free of
// a runtime DB import (it never calls db directly — callers always pass the tx).
type Executor = FiadoExecutor;

export type FindOrCreateCustomerArgs = {
  orgId: string;
  name: string;
  whatsapp?: string | null;
  documentId?: string | null;
  createdBy?: string | null;
};

export type CustomerIdResult = {
  id: string;
  name: string;
};

/**
 * find-or-create dedup strategy (ADR-7):
 *  1. Match on whatsapp (normalized) if provided — it is the collection contact.
 *  2. Else match on documentId if provided.
 *  3. Else create a new customers row.
 *
 * Race-safe: uses onConflictDoNothing on the unique index + re-select so
 * concurrent calls can't produce duplicate rows.
 *
 * Org-isolated: the partial unique indexes include organization_id so the same
 * whatsapp in two different orgs never collides.
 *
 * Deleted rows are excluded from dedup matches (the partial indexes enforce
 * WHERE deleted=false) — a new row is created even if a deleted one exists
 * with the same contact.
 */
export async function findOrCreateCustomer(
  executor: Executor,
  args: FindOrCreateCustomerArgs,
): Promise<CustomerIdResult> {
  const whatsapp = args.whatsapp?.trim() || null;
  const documentId = args.documentId?.trim() || null;

  // Step 1: try to find an existing active customer matching whatsapp
  if (whatsapp) {
    const [existing] = await executor
      .select({ id: customersSchema.id, name: customersSchema.name })
      .from(customersSchema)
      .where(
        and(
          eq(customersSchema.organizationId, args.orgId),
          eq(customersSchema.whatsapp, whatsapp),
          eq(customersSchema.deleted, false),
        ),
      )
      .limit(1);

    if (existing) {
      return existing;
    }
  }

  // Step 2: try to find by documentId (only when no whatsapp match)
  if (!whatsapp && documentId) {
    const [existing] = await executor
      .select({ id: customersSchema.id, name: customersSchema.name })
      .from(customersSchema)
      .where(
        and(
          eq(customersSchema.organizationId, args.orgId),
          eq(customersSchema.documentId, documentId),
          eq(customersSchema.deleted, false),
        ),
      )
      .limit(1);

    if (existing) {
      return existing;
    }
  }

  // Step 3: create a new customer.
  // Use onConflictDoNothing to be race-safe against the partial unique index,
  // then re-select to return the winner (whether we inserted or another session did).
  const [inserted] = await executor
    .insert(customersSchema)
    .values({
      organizationId: args.orgId,
      name: args.name,
      whatsapp: whatsapp ?? null,
      documentId: documentId ?? null,
      deleted: false,
      createdBy: args.createdBy ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: customersSchema.id, name: customersSchema.name });

  if (inserted) {
    return inserted;
  }

  // onConflictDoNothing fired — the conflict can be on EITHER unique index
  // (whatsapp or documentId). Re-select matching on whatsapp OR documentId so a
  // documentId collision with a brand-new whatsapp still finds the existing row
  // instead of throwing (latent 500).
  const matchers = [];
  if (whatsapp) {
    matchers.push(eq(customersSchema.whatsapp, whatsapp));
  }
  if (documentId) {
    matchers.push(eq(customersSchema.documentId, documentId));
  }

  const [winner] = await executor
    .select({ id: customersSchema.id, name: customersSchema.name })
    .from(customersSchema)
    .where(
      and(
        eq(customersSchema.organizationId, args.orgId),
        eq(customersSchema.deleted, false),
        matchers.length > 1 ? or(...matchers) : matchers[0],
      ),
    )
    .limit(1);

  if (!winner) {
    throw new Error('findOrCreateCustomer: failed to find or create customer row');
  }

  return winner;
}
