'use client';

import { useEffect, useState, useTransition } from 'react';
import { getFiadoTermDays, setFiadoTermDays } from '@/actions/fiados';
import { Button } from '@/components/ui/button';

// Per-organization default payment term for new fiados. The value is stored in
// app_settings (fiados-default-term-days) and read by the sale paths; the due
// date can still be overridden on each individual fiado sale.
export function FiadoTermField() {
  const [days, setDays] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getFiadoTermDays()
      .then((n) => {
        if (active) {
          setDays(String(n));
          setSaved(n);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  function commit() {
    const n = Number.parseInt(days, 10);
    if (!Number.isFinite(n) || n < 1 || n > 365) {
      setError('Elegí un plazo entre 1 y 365 días');
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const v = await setFiadoTermDays(n);
        setSaved(v);
        setDays(String(v));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al guardar');
      }
    });
  }

  const dirty = saved != null && days !== String(saved);

  return (
    <div className="rounded-md border border-border bg-muted/30 p-4">
      <div className="text-sm font-medium">Plazo de pago por defecto</div>
      <div className="mt-1 text-xs text-muted-foreground">
        Días para que venza un fiado nuevo. Podés cambiar la fecha en cada venta.
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={365}
          value={days}
          onChange={e => setDays(e.target.value)}
          className="
            h-9 w-24 rounded-md border border-input bg-card px-3 text-sm
            outline-none
            focus-visible:ring-2 focus-visible:ring-ring/30
          "
        />
        <span className="text-sm text-muted-foreground">días</span>
        <Button
          size="sm"
          onClick={commit}
          disabled={pending || !dirty}
          className="ml-auto"
        >
          {pending ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
    </div>
  );
}
