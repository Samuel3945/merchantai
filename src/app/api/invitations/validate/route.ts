import { clerkClient } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { employeeInvitationsSchema } from '@/models/Schema';

/** Resolves the Clerk organization name; null if it can't be read. */
async function resolveOrgName(organizationId: string): Promise<string | null> {
  try {
    const org = await (await clerkClient()).organizations.getOrganization({
      organizationId,
    });
    return org.name;
  } catch {
    return null;
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const token = url.searchParams.get('token')?.trim();

  if (!token) {
    return NextResponse.json(
      { valid: false, reason: 'missing_token' },
      { status: 400 },
    );
  }

  const [invitation] = await db
    .select({
      id: employeeInvitationsSchema.id,
      email: employeeInvitationsSchema.email,
      name: employeeInvitationsSchema.name,
      role: employeeInvitationsSchema.role,
      status: employeeInvitationsSchema.status,
      expiresAt: employeeInvitationsSchema.expiresAt,
      organizationId: employeeInvitationsSchema.organizationId,
    })
    .from(employeeInvitationsSchema)
    .where(eq(employeeInvitationsSchema.token, token))
    .limit(1);

  if (!invitation) {
    return NextResponse.json(
      { valid: false, reason: 'not_found' },
      { status: 404 },
    );
  }

  if (invitation.status === 'accepted') {
    return NextResponse.json(
      { valid: false, reason: 'used' },
      { status: 410 },
    );
  }
  if (invitation.status === 'revoked') {
    return NextResponse.json(
      { valid: false, reason: 'revoked' },
      { status: 410 },
    );
  }
  if (
    invitation.status === 'expired'
    || invitation.expiresAt.getTime() <= Date.now()
  ) {
    if (invitation.status !== 'expired') {
      await db
        .update(employeeInvitationsSchema)
        .set({ status: 'expired' })
        .where(eq(employeeInvitationsSchema.id, invitation.id));
    }
    return NextResponse.json(
      { valid: false, reason: 'expired' },
      { status: 410 },
    );
  }

  const organizationName = await resolveOrgName(invitation.organizationId);

  return NextResponse.json({
    valid: true,
    invitation: {
      email: invitation.email,
      name: invitation.name,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      organizationId: invitation.organizationId,
      organizationName,
    },
  });
}
