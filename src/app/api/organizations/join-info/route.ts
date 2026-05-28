import { clerkClient, verifyToken } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { Env } from '@/libs/Env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type TicketClaims = {
  org_id?: string;
  oid?: string;
  organization_id?: string;
  email?: string;
  invitation_id?: string;
};

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const token = url.searchParams.get('token')?.trim();

  if (!token) {
    return NextResponse.json(
      { valid: false, reason: 'missing_token' },
      { status: 400 },
    );
  }

  let claims: TicketClaims;
  try {
    claims = (await verifyToken(token, {
      secretKey: Env.CLERK_SECRET_KEY,
    })) as TicketClaims;
  } catch {
    return NextResponse.json(
      { valid: false, reason: 'invalid_token' },
      { status: 400 },
    );
  }

  const organizationId
    = claims.org_id ?? claims.oid ?? claims.organization_id;

  if (!organizationId) {
    return NextResponse.json(
      { valid: false, reason: 'invalid_token' },
      { status: 400 },
    );
  }

  let organization;
  try {
    organization = await (await clerkClient()).organizations.getOrganization({
      organizationId,
    });
  } catch {
    return NextResponse.json(
      { valid: false, reason: 'organization_not_found' },
      { status: 404 },
    );
  }

  return NextResponse.json({
    valid: true,
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      imageUrl: organization.imageUrl,
    },
    invitedEmail: claims.email ?? null,
  });
}
