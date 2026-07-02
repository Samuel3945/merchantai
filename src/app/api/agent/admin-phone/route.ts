/**
 * GET /api/agent/admin-phone
 *
 * Returns the organization's configured business phone — the "admin" number set
 * in Ajustes → Datos del negocio, persisted as the `business_phone` app setting.
 *
 * Deliberately SEPARATE from /conversations/upsert. That endpoint reports
 * conversation STATE (botPaused / blocked); this one reports the org's admin
 * IDENTITY. Keeping them apart means neither concern leaks into the other.
 *
 * n8n calls this, then does the isAdmin decision itself: it compares the
 * caller's remoteJid against `adminPhoneDigits` (both reduced to their last 10
 * digits). A non-matching caller is a client — the safe default.
 *
 * The org comes exclusively from the agent token — request values are ignored.
 */
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { requireAgentAuth } from '@/libs/agent-auth';
import { db } from '@/libs/db-context';
import { phoneDigits } from '@/libs/phone';
import { appSettingsSchema } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const BUSINESS_PHONE_KEY = 'business_phone';

export async function GET(req: Request): Promise<Response> {
  const { ctx, errorResponse } = await requireAgentAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const { organizationId } = ctx;

  const [row] = await db
    .forOrg(organizationId)
    .select({ value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, organizationId),
        eq(appSettingsSchema.key, BUSINESS_PHONE_KEY),
      ),
    )
    .limit(1);

  const adminPhone = row?.value?.trim() ?? '';

  return NextResponse.json({
    adminPhone,
    adminPhoneDigits: phoneDigits(adminPhone),
  });
}
