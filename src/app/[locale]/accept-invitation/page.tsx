import { setRequestLocale } from 'next-intl/server';
import { AcceptInvitationClient } from '@/features/employees/AcceptInvitationClient';

export default async function AcceptInvitationPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string; userId?: string }>;
}) {
  const { locale } = await props.params;
  const { token, userId } = await props.searchParams;
  setRequestLocale(locale);

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="
          rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3
          text-sm text-destructive
        "
        >
          Falta el token de invitación.
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
        <AcceptInvitationClient token={token} userId={userId} locale={locale} />
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
