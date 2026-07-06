'use client';

import { ToggleRow } from './fields';
import { useSettingSave } from './useSettingSave';

// Ajustes → Vales. Master toggle for employee loans (vales / préstamos). While
// ON, the POS lets the cashier hand a vale to an employee from Caja → Salida.
// Turning it OFF only blocks NEW vales — existing loans can still be repaid.
export function EmployeeLoansTab({ initialEnabled }: { initialEnabled: boolean }) {
  const { save } = useSettingSave();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Vales a empleados</h2>
        <p className="text-sm text-muted-foreground">
          Controla si tu negocio entrega vales (préstamos) a los empleados desde
          la caja.
        </p>
      </div>

      <ToggleRow
        label="¿Permitir vales / préstamos a empleados?"
        description="Si está activo, en el POS podrás entregar un vale (préstamo) a un empleado desde Caja → Salida. Aunque lo desactives, los abonos de préstamos existentes se siguen registrando."
        initial={initialEnabled}
        onCommit={v =>
          save('modules.employee_loans', v ? 'true' : 'false', {
            notifyConfigChange: true,
          })}
      />
    </div>
  );
}
