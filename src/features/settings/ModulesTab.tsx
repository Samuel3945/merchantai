'use client';

import { ToggleRow } from './fields';
import { useSettingSave } from './useSettingSave';

export type ModulesTabValues = {
  'modules.employees': boolean;
};

export function ModulesTab({ initial }: { initial: ModulesTabValues }) {
  const { save } = useSettingSave();

  const persist = (key: keyof ModulesTabValues, value: boolean) =>
    save(key, value ? 'true' : 'false', { notifyConfigChange: true });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Módulos</h2>
        <p className="text-sm text-muted-foreground">
          Activa o desactiva funciones del POS. Los cambios se aplican de
          inmediato a la app de cajero.
        </p>
      </div>

      <div className="space-y-3">
        <ToggleRow
          label="Empleados"
          description="Permite múltiples cajeros, turnos y permisos por rol."
          initial={initial['modules.employees']}
          onCommit={v => persist('modules.employees', v)}
        />
      </div>
    </div>
  );
}
