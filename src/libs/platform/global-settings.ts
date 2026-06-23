import { and, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { appSettingsSchema } from '@/models/Schema';

/**
 * Platform-wide settings.
 *
 * `app_settings` is keyed by (organization_id, key). Platform-level switches
 * have no real organization, so they live under a RESERVED id that can never
 * collide with a Clerk org id (those are always `org_…`). This lets the
 * operator keep global flags without a dedicated table or migration.
 *
 * The readers here are NOT org-scoped and take no auth: they are meant to be
 * called from server components (layout, onboarding page) on every request. The
 * WRITE side lives in `actions/platform-orgs.ts#setOnboardingForced` and is
 * gated behind `requirePlatformOperator`.
 */
export const PLATFORM_GLOBAL_ORG_ID = '__platform_global__';

/**
 * When 'true', new org owners are forced through the onboarding wizard until
 * they complete it (the original product behavior). Default (unset) is OFF:
 * the wizard is removed from the normal flow and only the platform operator can
 * open `/onboarding`, for testing. Toggled from `/platform`.
 */
export const ONBOARDING_FORCED_KEY = 'platform.onboarding_forced';

async function getGlobalSetting(key: string): Promise<string> {
  const [row] = await db
    .select({ value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, PLATFORM_GLOBAL_ORG_ID),
        eq(appSettingsSchema.key, key),
      ),
    )
    .limit(1);

  return row?.value ?? '';
}

export async function isOnboardingForced(): Promise<boolean> {
  return (await getGlobalSetting(ONBOARDING_FORCED_KEY)) === 'true';
}
