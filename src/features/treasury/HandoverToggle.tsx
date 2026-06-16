'use client';

import { useState, useTransition } from 'react';
import { setTreasuryHandoverEnabled } from '@/actions/treasury';
import { Switch } from '@/components/ui/switch';
import { Toaster } from '@/components/ui/toast';
import { toast } from '@/components/ui/toast-store';

/**
 * Owner-gated toggle for the treasury handover opt-in flag.
 * When ON: close sessions emit a handover movement into the Pendiente (transito)
 * account — money must be placed via the queue before it appears in vault/banco.
 * When OFF (default): carry-over behavior (Option A) — no handover, no placement
 * required. This is the safer default and the existing prod behavior.
 *
 * Rendered on the Tesorería page, visible only to org:admin callers
 * (server-side check already in the action; UI hides it from non-owners via the
 * `isOwner` prop).
 */
export function HandoverToggle({
  initialEnabled,
}: {
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();

  function toggle(next: boolean) {
    startTransition(async () => {
      const result = await setTreasuryHandoverEnabled(next);
      if (result.ok) {
        setEnabled(result.data.enabled);
        toast.success(
          next
            ? 'Traspaso activado — los cierres de caja registrarán un movimiento pendiente de ubicar'
            : 'Traspaso desactivado — los cierres vuelven al traslado automático',
        );
      } else {
        toast.error(result.error ?? 'No se pudo actualizar la configuración');
      }
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <Toaster />
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 pr-4">
          <div className="text-sm font-medium">Flujo de traspaso (cierre → tesorería)</div>
          <p className="text-xs text-muted-foreground">
            Cuando está activo, cada cierre de caja genera un movimiento pendiente de ubicar
            en el panel de tesorería. El dueño decide adónde va el efectivo (bóveda, banco
            o gasto). Por defecto está desactivado — el saldo se traslada automáticamente.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={pending}
          onCheckedChange={toggle}
          aria-label="Activar flujo de traspaso"
        />
      </div>
    </div>
  );
}
