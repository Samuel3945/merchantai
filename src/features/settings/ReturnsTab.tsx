'use client';

import { useState } from 'react';
import { TextField, ToggleRow } from './fields';
import { useSettingSave } from './useSettingSave';

export type ReturnsTabValues = {
  returns_enabled: boolean;
  returns_max_days: string;
  returns_require_admin: boolean;
};

export function ReturnsTab({ initial }: { initial: ReturnsTabValues }) {
  const { save } = useSettingSave();
  const [enabled, setEnabled] = useState(initial.returns_enabled);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Devoluciones</h2>
        <p className="text-sm text-muted-foreground">
          Define las reglas para aceptar devoluciones desde el POS.
        </p>
      </div>

      <div className="space-y-3">
        <ToggleRow
          label="Permitir devoluciones"
          description="Cuando está desactivado, el cajero no podrá iniciar una devolución."
          initial={initial.returns_enabled}
          onCommit={(v) => {
            setEnabled(v);
            save('returns_enabled', v ? 'true' : 'false');
          }}
        />

        <div className={enabled ? '' : 'pointer-events-none opacity-50'}>
          <TextField
            id="returns_max_days"
            label="Días máximos para devolución"
            type="number"
            initial={initial.returns_max_days || '7'}
            placeholder="7"
            hint="Después de este número de días desde la venta, la devolución se rechaza."
            onCommit={(v) => {
              const n = Number(v);
              if (!Number.isFinite(n) || n < 0) {
                return;
              }
              save('returns_max_days', String(Math.floor(n)));
            }}
          />
        </div>

        <div className={enabled ? '' : 'pointer-events-none opacity-50'}>
          <ToggleRow
            label="Requiere autorización de administrador"
            description="El cajero deberá ingresar credenciales de admin para procesar la devolución."
            initial={initial.returns_require_admin}
            disabled={!enabled}
            onCommit={v =>
              save('returns_require_admin', v ? 'true' : 'false')}
          />
        </div>
      </div>
    </div>
  );
}
