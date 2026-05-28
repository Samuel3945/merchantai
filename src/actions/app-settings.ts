'use server';

import { auth } from '@clerk/nextjs/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/libs/DB';
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
  if (orgRole && orgRole !== 'org:admin') {
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

  await db
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

  return { key, value };
}
