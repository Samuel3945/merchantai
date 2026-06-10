import { and, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { appSettingsSchema } from '@/models/Schema';

// The org's own OpenAI key (BYOK) saved in Settings › Integrations, or null when
// it should fall back to the platform key. Shared by the AI categorizer and the
// AI importer so key resolution lives in one place.
export async function resolveOrgOpenAiKey(
  orgId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, orgId),
        eq(appSettingsSchema.key, 'openai_api_key'),
      ),
    )
    .limit(1);
  return row?.value?.trim() || null;
}
