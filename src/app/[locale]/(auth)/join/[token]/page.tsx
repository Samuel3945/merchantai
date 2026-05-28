import { auth, clerkClient, verifyToken } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { JoinOrganizationClient } from '@/features/employees/JoinOrganizationClient';
import { Env } from '@/libs/Env';

type TicketClaims = {
  org_id?: string;
  oid?: string;
  organization_id?: string;
  email?: string;
};

async function resolveOrgFromTicket(ticket: string) {
  let claims: TicketClaims;
  try {
    claims = (await verifyToken(ticket, {
      secretKey: Env.CLERK_SECRET_KEY,
    })) as TicketClaims;
  } catch {
    return null;
  }

  const organizationId
    = claims.org_id ?? claims.oid ?? claims.organization_id;
  if (!organizationId) {
    return null;
  }

  try {
    const org = await (await clerkClient()).organizations.getOrganization({
      organizationId,
    });
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      imageUrl: org.imageUrl,
      invitedEmail: claims.email ?? null,
    };
  } catch {
    return null;
  }
}

export default async function JoinPage(props: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await props.params;
  setRequestLocale(locale);

  const orgInfo = await resolveOrgFromTicket(token);
  const { userId } = await auth();

  if (!orgInfo) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="
          w-full max-w-md space-y-4 rounded-lg border bg-background p-6
          text-center shadow-sm
        "
        >
          <div className="text-2xl font-semibold">Enlace inválido</div>
          <div className="
            rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2
            text-sm text-destructive
          "
          >
            Este enlace de invitación no es válido o ha expirado.
          </div>
          <a
            href={`/${locale}/sign-in`}
            className="
              inline-flex h-9 w-full items-center justify-center rounded-md
              bg-primary px-4 text-sm font-medium text-primary-foreground
              shadow-xs
              hover:bg-primary/90
            "
          >
            Ir al login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="
        w-full max-w-md rounded-lg border bg-background p-6 shadow-sm
      "
      >
        <JoinOrganizationClient
          token={token}
          locale={locale}
          isSignedIn={!!userId}
          organizationName={orgInfo.name}
          organizationImageUrl={orgInfo.imageUrl}
          invitedEmail={orgInfo.invitedEmail}
        />
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
