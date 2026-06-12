'use client';

import { ToggleRow } from './fields';
import { useSettingSave } from './useSettingSave';

export type ModulesTabValues = {
  'modules.employees': boolean;
  'modules.delivery': boolean;
  'modules.suppliers': boolean;
  'modules.facturas': boolean;
};

// Optional modules a one-person shop may never use. All default to ENABLED;
// turning one off hides its section from the panel navigation.
const MODULE_TOGGLES: Array<{
  key: keyof ModulesTabValues;
  label: string;
  description: string;
}> = [
  {
    key: 'modules.employees',
    label: 'Empleados',
    description: 'Permite múltiples cajeros, permisos por usuario y PINs.',
  },
  {
    key: 'modules.delivery',
    label: 'Domicilios',
    description: 'Pedidos a domicilio y seguimiento del domiciliario.',
  },
  {
    key: 'modules.suppliers',
    label: 'Proveedores',
    description: 'Base de proveedores y pagos de mercancía.',
  },
  {
    key: 'modules.facturas',
    label: 'Facturas',
    description: 'Facturación electrónica DIAN y su historial.',
  },
];

export function ModulesTab({ initial }: { initial: ModulesTabValues }) {
  const { save } = useSettingSave();

  const persist = (key: keyof ModulesTabValues, value: boolean) =>
    save(key, value ? 'true' : 'false', { notifyConfigChange: true });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Módulos</h2>
        <p className="text-sm text-muted-foreground">
          Activa o desactiva funciones según cómo trabaja tu negocio. Si
          atiendes solo, puedes ocultar lo que no uses; todo viene activo por
          defecto.
        </p>
      </div>

      <div className="space-y-3">
        {MODULE_TOGGLES.map(m => (
          <ToggleRow
            key={m.key}
            label={m.label}
            description={m.description}
            initial={initial[m.key]}
            onCommit={v => persist(m.key, v)}
          />
        ))}
      </div>
    </div>
  );
}
