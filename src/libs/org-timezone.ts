import { and, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { ORG_TIMEZONE_SETTING_KEY, resolveOrgTimezone } from '@/libs/timezone';
import { appSettingsSchema } from '@/models/Schema';

// Effective IANA timezone for an organization, read from app_settings and
// clamped to a supported zone (see libs/timezone.ts). Takes orgId directly so
// hot paths that already authenticated don't pay a second auth round-trip.
// Defaults to America/Bogota when unset. Reusable by the future report
// internationalization sweep.
export async function getOrgTimezone(orgId: string): Promise<string> {
  const [row] = await db
    .select({ value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, orgId),
        eq(appSettingsSchema.key, ORG_TIMEZONE_SETTING_KEY),
      ),
    )
    .limit(1);

  return resolveOrgTimezone(row?.value ?? null);
}
