'use server';

import { auth, clerkClient } from '@clerk/nextjs/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { logger } from '@/libs/Logger';
import { appSettingsSchema } from '@/models/Schema';

export type AppSetting = {
  key: string;
  value: string;
};

async function requireOrg() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return { userId, orgId };
}

async function requireAdminOrg() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole !== 'org:admin') {
    throw new Error('Only organization admins can change settings');
  }
  return { userId, orgId };
}

export async function getAppSetting(key: string): Promise<AppSetting> {
  if (!key) {
    throw new Error('key is required');
  }
  const { orgId } = await requireOrg();

  const [row] = await db
    .select({
      key: appSettingsSchema.key,
      value: appSettingsSchema.value,
    })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, orgId),
        eq(appSettingsSchema.key, key),
      ),
    )
    .limit(1);

  return row ?? { key, value: '' };
}

export async function setAppSetting(
  key: string,
  value: string,
): Promise<AppSetting> {
  if (!key) {
    throw new Error('key is required');
  }
  const { orgId } = await requireAdminOrg();

  await db.transaction(async (tx) => {
    await tx
      .insert(appSettingsSchema)
      .values({
        organizationId: orgId,
        key,
        value,
      })
      .onConflictDoUpdate({
        target: [appSettingsSchema.organizationId, appSettingsSchema.key],
        set: {
          value,
          updatedAt: sql`now()`,
        },
      });

    // Keep the Credito payment method's `active` flag in sync with the
    // credito-enabled toggle. The two were decoupled, so payment_methods kept
    // the credit row active=true after credito was turned off and the POS still
    // received it as a payment option. Syncing here in the same transaction
    // makes this toggle the single source of truth. See issue #8.
    if (key === 'credito-enabled') {
      const enabled = value === 'true';
      await tx.execute(
        sql`UPDATE payment_methods SET active = ${enabled}
            WHERE organization_id = ${orgId} AND type = 'credit'`,
      );
    }
  });

  // The business name IS the organization name: renaming one renames the
  // other so the org switcher, invoices and tickets never disagree.
  // Best-effort — a Clerk hiccup must not fail the settings save.
  if (key === 'business_name' && value.trim()) {
    try {
      const client = await clerkClient();
      await client.organizations.updateOrganization(orgId, {
        name: value.trim(),
      });
    } catch (err) {
      logger.error('business_name_org_sync_failed', {
        organizationId: orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { key, value };
}
