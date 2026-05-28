'use client';

import { useOrganizationList } from '@clerk/nextjs';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function JoinOrganizationClient({
  token,
  locale,
  isSignedIn,
  organizationName,
  organizationImageUrl,
  invitedEmail,
}: {
  token: string;
  locale: string;
  isSignedIn: boolean;
  organizationName: string;
  organizationImageUrl: string | null;
  invitedEmail: string | null;
}) {
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { userInvitations, setActive } = useOrganizationList({
    userInvitations: { status: 'pending' },
  });

  const handleJoinExisting = async () => {
    setJoining(true);
    setError(null);
    try {
      const pending = userInvitations?.data ?? [];
      const match = pending.find(inv => inv.publicOrganizationData?.name === organizationName);
      if (match) {
        await match.accept();
        if (setActive) {
          await setActive({ organization: match.publicOrganizationData?.id ?? null });
        }
        window.location.assign(`/${locale}/dashboard`);
      } else {
        setError('No se encontró la invitación en tu cuenta. Intenta con el enlace del email.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo unir a la organización');
    } finally {
      setJoining(false);
    }
  };

  const handleCreateAccount = () => {
    const signUpUrl = `/${locale}/sign-up#/?__clerk_ticket=${encodeURIComponent(token)}`;
    window.location.assign(signUpUrl);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3 text-center">
        {organizationImageUrl && (
          <img
            src={organizationImageUrl}
            alt={organizationName}
            className="mx-auto size-16 rounded-full object-cover"
          />
        )}
        <div className="text-2xl font-semibold">
          Únete a
          {' '}
          {organizationName}
        </div>
        <p className="text-sm text-muted-foreground">
          Has sido invitado a unirte a esta organización
          {invitedEmail ? ` como ${invitedEmail}` : ''}
          .
        </p>
      </div>

      {error && (
        <div className="
          rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2
          text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      {isSignedIn
        ? (
            <div className="space-y-3">
              <Button
                className="w-full"
                disabled={joining}
                onClick={handleJoinExisting}
              >
                {joining ? 'Uniéndose…' : 'Unirme con mi cuenta actual'}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Se usará tu sesión activa de Clerk.
              </p>
            </div>
          )
        : (
            <div className="space-y-3">
              <Button className="w-full" onClick={handleCreateAccount}>
                Crear cuenta y unirme
              </Button>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">o</span>
                </div>
              </div>
              <a
                href={`/${locale}/sign-in#/?__clerk_ticket=${encodeURIComponent(token)}`}
                className="
                  inline-flex h-9 w-full items-center justify-center rounded-md
                  border bg-background px-4 text-sm font-medium shadow-xs
                  hover:bg-accent hover:text-accent-foreground
                "
              >
                Ya tengo cuenta — Iniciar sesión
              </a>
            </div>
          )}
    </div>
  );
}
