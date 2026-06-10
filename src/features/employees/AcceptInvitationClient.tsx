'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-xs font-medium text-muted-foreground';

const POS_SESSION_STORAGE_KEY = 'pos.sessionId';

type ValidateResponse
  = | {
    valid: true;
    invitation: {
      email: string;
      name: string;
      role: string;
      expiresAt: string;
      organizationId: string;
      organizationName: string | null;
    };
  }
  | { valid: false; reason: string };

type InvitationInfo = {
  email: string;
  name: string;
  role: string;
  organizationName: string | null;
};

type Strength = {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  color: string;
};

function scorePassword(password: string): Strength {
  if (!password) {
    return { score: 0, label: '', color: 'bg-muted' };
  }
  let score = 0;
  if (password.length >= 8) {
    score++;
  }
  if (password.length >= 12) {
    score++;
  }
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) {
    score++;
  }
  if (/\d/.test(password) && /[^A-Z0-9]/i.test(password)) {
    score++;
  }
  const bounded = Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
  const labels = ['Muy débil', 'Débil', 'Aceptable', 'Buena', 'Fuerte'];
  const colors = [
    'bg-muted',
    'bg-destructive',
    'bg-orange-500',
    'bg-yellow-500',
    'bg-emerald-500',
  ];
  return {
    score: bounded,
    label: labels[bounded] ?? '',
    color: colors[bounded] ?? 'bg-muted',
  };
}

function describeError(reason: string): string {
  switch (reason) {
    case 'not_found':
      return 'Esta invitación no existe o el enlace es inválido.';
    case 'used':
      return 'Esta invitación ya fue utilizada.';
    case 'expired':
      return 'Esta invitación expiró. Solicita una nueva al administrador.';
    case 'revoked':
      return 'Esta invitación fue revocada por el administrador.';
    case 'missing_token':
      return 'Falta el token de invitación en el enlace.';
    default:
      return 'No se pudo validar la invitación.';
  }
}

export function AcceptInvitationClient({
  token,
  userId,
  locale,
}: {
  token: string;
  userId?: string;
  locale: string;
}) {
  const [loadingInvite, setLoadingInvite] = useState(true);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<InvitationInfo | null>(null);

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/invitations/validate?token=${encodeURIComponent(token)}`,
          { cache: 'no-store' },
        );
        const data: ValidateResponse = await res.json();
        if (cancelled) {
          return;
        }
        if (!data.valid) {
          setInviteError(describeError(data.reason));
        } else {
          setInvitation({
            email: data.invitation.email,
            name: data.invitation.name,
            role: data.invitation.role,
            organizationName: data.invitation.organizationName,
          });
          setName(data.invitation.name);
        }
      } catch {
        if (!cancelled) {
          setInviteError('No se pudo contactar al servidor.');
        }
      } finally {
        if (!cancelled) {
          setLoadingInvite(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const strength = useMemo(() => scorePassword(password), [password]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(
          describeError(data?.error ?? '') !== 'No se pudo validar la invitación.'
            ? describeError(data.error)
            : (data?.error ?? 'No se pudo activar la cuenta'),
        );
      }

      if (typeof window !== 'undefined' && data.sessionId) {
        window.localStorage.setItem(POS_SESSION_STORAGE_KEY, data.sessionId);
      }

      window.location.assign('/pos');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo activar la cuenta');
      setSubmitting(false);
    }
  };

  if (loadingInvite) {
    return (
      <div className="space-y-2 text-center">
        <div className="text-lg font-medium">Validando invitación…</div>
        <p className="text-sm text-muted-foreground">Un momento por favor.</p>
      </div>
    );
  }

  if (inviteError) {
    return (
      <div className="space-y-4 text-center">
        <div className="text-2xl font-semibold">Invitación no válida</div>
        <div className="
          rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2
          text-sm text-destructive
        "
        >
          {inviteError}
        </div>
        <Button
          type="button"
          className="w-full"
          onClick={() => window.location.assign(`/${locale}/sign-in`)}
        >
          Ir al login
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1">
        <div className="text-2xl font-semibold">Activa tu cuenta</div>
        {invitation && (
          <>
            <p className="text-sm text-muted-foreground">
              {invitation.organizationName
                ? (
                    <>
                      Te uniste al negocio
                      {' '}
                      <span className="font-medium text-foreground">
                        {invitation.organizationName}
                      </span>
                      . Crea tu contraseña para entrar.
                    </>
                  )
                : 'Crea tu contraseña para activar tu cuenta.'}
            </p>
            <p className="text-xs text-muted-foreground">
              Cuenta:
              {' '}
              <span className="font-medium text-foreground">{invitation.email}</span>
            </p>
          </>
        )}
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

      <div className="space-y-1">
        <label htmlFor="name" className={labelCls}>
          Nombre completo
        </label>
        <input
          id="name"
          type="text"
          required
          value={name}
          onChange={e => setName(e.target.value)}
          className={inputCls}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className={labelCls}>
          Contraseña
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={e => setPassword(e.target.value)}
          className={inputCls}
        />
        {password.length > 0 && (
          <div className="space-y-1 pt-1">
            <div className="flex gap-1">
              {[1, 2, 3, 4].map(i => (
                <div
                  key={i}
                  className={`
                    h-1 flex-1 rounded-sm
                    ${
                i <= strength.score ? strength.color : 'bg-muted'
                }
                  `}
                />
              ))}
            </div>
            <div className="text-xs text-muted-foreground">
              Fuerza:
              {' '}
              <span className="font-medium text-foreground">{strength.label}</span>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor="confirm" className={labelCls}>
          Confirmar contraseña
        </label>
        <input
          id="confirm"
          type="password"
          required
          minLength={8}
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          className={inputCls}
        />
        {confirm.length > 0 && confirm !== password && (
          <div className="text-xs text-destructive">
            Las contraseñas no coinciden
          </div>
        )}
      </div>

      {userId && (
        <input type="hidden" name="userId" value={userId} />
      )}

      <Button
        type="submit"
        disabled={
          submitting
          || password.length < 8
          || password !== confirm
          || name.trim().length === 0
        }
        className="w-full"
      >
        {submitting ? 'Activando…' : 'Activar cuenta'}
      </Button>
    </form>
  );
}
