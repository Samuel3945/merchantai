'use client';

import { useState, useTransition } from 'react';
import { updateMyContact } from '@/actions/employees';
import { Button } from '@/components/ui/button';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-xs font-medium text-muted-foreground';

type Status = { kind: 'idle' | 'ok' | 'error'; message?: string };

export function MyProfileClient({
  initialPhone,
  hasProfile,
}: {
  initialPhone: string | null;
  hasProfile: boolean;
}) {
  const [phone, setPhone] = useState(initialPhone ?? '');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [pending, startTransition] = useTransition();

  // The owner is a Clerk member with no posUsers row, so there is nothing to
  // edit here — their business number lives in Ajustes instead.
  if (!hasProfile) {
    return (
      <p className="
        max-w-xl rounded-md border border-input bg-muted/30 p-4 text-sm
        text-muted-foreground
      "
      >
        Tu cuenta es la dueña de la organización. El número de contacto del
        negocio se configura en
        {' '}
        <span className="font-medium text-foreground">Ajustes → Negocio</span>
        .
      </p>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setStatus({ kind: 'idle' });
    startTransition(async () => {
      const result = await updateMyContact({ phone: phone.trim() || null });
      if (!result.ok) {
        setStatus({ kind: 'error', message: result.error });
        return;
      }
      setPhone(result.data.phone ?? '');
      setStatus({ kind: 'ok', message: 'WhatsApp actualizado.' });
    });
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-md space-y-4">
      <div>
        <label htmlFor="my-phone" className={labelCls}>
          Mi WhatsApp
        </label>
        <input
          id="my-phone"
          type="tel"
          value={phone}
          onChange={e => setPhone(e.target.value)}
          placeholder="+57 300 000 0000"
          className={inputCls}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Es el número donde el asistente te escribe sobre cambios de precio,
          ofertas y cobertura de turnos. Mantenelo al día.
        </p>
      </div>

      {status.kind === 'ok' && (
        <p className="text-sm text-emerald-600">{status.message}</p>
      )}
      {status.kind === 'error' && (
        <p className="text-sm text-destructive">{status.message}</p>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? 'Guardando…' : 'Guardar'}
      </Button>
    </form>
  );
}
