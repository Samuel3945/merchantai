'use client';

import { useState } from 'react';
import {
  BLOCK_CLOSE_SETTING_KEY,
  DEFAULT_RESOLUTION_SETTING_KEY,
} from '@/libs/transfer-reconciliation-keys';
import { SelectField, ToggleRow } from './fields';
import { useSettingSave } from './useSettingSave';

export type TransferSecurityTabValues = {
  blockCloseOnInvestigation: boolean;
  defaultResolution: 'investigate' | 'direct_loss';
};

type DefaultResolution = TransferSecurityTabValues['defaultResolution'];

const DEFAULT_RESOLUTION_OPTIONS: ReadonlyArray<{
  value: DefaultResolution;
  label: string;
}> = [
  { value: 'investigate', label: 'Investigar (abrir caso)' },
  { value: 'direct_loss', label: 'Pérdida directa (cerrar automáticamente)' },
];

const RESOLUTION_HINT: Record<DefaultResolution, string> = {
  investigate:
    'Predeterminado: cada transferencia no llegada abre un caso de '
    + 'investigación para que el administrador decida el resultado.',
  direct_loss:
    'Activo: cada nueva transferencia no llegada se cierra '
    + 'automáticamente como pérdida, sin pasar por investigación.',
};

export function TransferSecurityTab({
  initial,
}: {
  initial: TransferSecurityTabValues;
}) {
  const { save } = useSettingSave();
  const [resolution, setResolution] = useState<DefaultResolution>(
    initial.defaultResolution,
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Seguridad de transferencias</h2>
        <p className="text-sm text-muted-foreground">
          Controles de administrador para el flujo de investigación de
          transferencias no llegadas. Solo los administradores pueden cambiar
          estas opciones.
        </p>
      </div>

      <div className="space-y-3">
        <ToggleRow
          label="Bloquear cierre de caja con investigaciones abiertas"
          description={
            'Cuando está activado, el cajero no puede cerrar la sesión de caja si '
            + 'hay transferencias en estado "no llegó" sin resolver. Esto obliga '
            + 'a resolver cada caso antes de cuadrar.'
          }
          initial={initial.blockCloseOnInvestigation}
          onCommit={v =>
            save(BLOCK_CLOSE_SETTING_KEY, v ? 'true' : 'false')}
        />

        <SelectField
          id="transfer-default-resolution"
          label="Resolución predeterminada para transferencias no llegadas"
          initial={resolution}
          options={DEFAULT_RESOLUTION_OPTIONS}
          hint={RESOLUTION_HINT[resolution]}
          onCommit={(v) => {
            setResolution(v);
            save(DEFAULT_RESOLUTION_SETTING_KEY, v);
          }}
        />
      </div>
    </div>
  );
}
