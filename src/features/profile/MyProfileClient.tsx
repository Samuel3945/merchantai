'use client';

import { useState, useTransition } from 'react';
import { updateMyContact, updateMyPin } from '@/actions/employees';
import { Button } from '@/components/ui/button';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-xs font-medium text-muted-foreground';

type Status = { kind: 'idle' | 'ok' | 'error'; message?: string };

const onlyDigits = (value: string) => value.replace(/\D/g, '').slice(0, 8);

export function MyProfileClient({
  initialPhone,
  hasProfile,
  canCashier,
  initialHasPin,
}: {
  initialPhone: string | null;
  hasProfile: boolean;
  canCashier: boolean;
  initialHasPin: boolean;
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
    <div className="max-w-md space-y-8">
      <form onSubmit={handleSubmit} className="space-y-4">
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

      {canCashier && <PinSection initialHasPin={initialHasPin} />}
    </div>
  );
}

// Personal POS PIN. Cajas open with the token only, so this PIN is what ties an
// action in a shared caja to the employee who ran it. It is optional — without
// it the employee still operates, but the responsibility is shared across
// everyone who uses that caja.
function PinSection({ initialHasPin }: { initialHasPin: boolean }) {
  const [hasPin, setHasPin] = useState(initialHasPin);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [pending, startTransition] = useTransition();

  const newPinValid = /^\d{4,8}$/.test(newPin);

  const save = (remove: boolean) => {
    setStatus({ kind: 'idle' });
    if (!remove && !newPinValid) {
      setStatus({
        kind: 'error',
        message: 'El PIN debe tener entre 4 y 8 dígitos',
      });
      return;
    }
    startTransition(async () => {
      const result = await updateMyPin({
        currentPin: currentPin || undefined,
        newPin: remove ? '' : newPin,
      });
      if (!result.ok) {
        setStatus({ kind: 'error', message: result.error });
        return;
      }
      setHasPin(result.data.hasPin);
      setCurrentPin('');
      setNewPin('');
      setStatus({
        kind: 'ok',
        message: result.data.hasPin ? 'PIN actualizado.' : 'PIN eliminado.',
      });
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(false);
      }}
      className="space-y-4 border-t pt-6"
    >
      <div>
        <div className="text-sm font-semibold">PIN personal de cajero</div>
        <p className="mt-1 text-xs text-muted-foreground">
          La caja abre solo con su código de acceso. Tu PIN personal identifica
          quién hace cada venta o movimiento: lo que se haga con tu PIN queda a
          tu nombre. Es opcional, pero sin él la responsabilidad se reparte entre
          todos los que usan esa caja.
        </p>
      </div>

      {hasPin && (
        <div>
          <label htmlFor="my-current-pin" className={labelCls}>
            PIN actual
          </label>
          <input
            id="my-current-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={currentPin}
            onChange={e => setCurrentPin(onlyDigits(e.target.value))}
            placeholder="Tu PIN actual"
            className={inputCls}
          />
        </div>
      )}

      <div>
        <label htmlFor="my-new-pin" className={labelCls}>
          {hasPin ? 'Nuevo PIN' : 'PIN'}
        </label>
        <input
          id="my-new-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={newPin}
          onChange={e => setNewPin(onlyDigits(e.target.value))}
          placeholder="4 a 8 dígitos"
          className={inputCls}
        />
        {newPin !== '' && !newPinValid && (
          <p className="mt-1 text-xs text-destructive">
            El PIN debe tener entre 4 y 8 dígitos.
          </p>
        )}
      </div>

      {status.kind === 'ok' && (
        <p className="text-sm text-emerald-600">{status.message}</p>
      )}
      {status.kind === 'error' && (
        <p className="text-sm text-destructive">{status.message}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || !newPinValid}>
          {pending ? 'Guardando…' : hasPin ? 'Cambiar PIN' : 'Guardar PIN'}
        </Button>
        {hasPin && (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => save(true)}
          >
            Quitar PIN
          </Button>
        )}
      </div>
    </form>
  );
}
