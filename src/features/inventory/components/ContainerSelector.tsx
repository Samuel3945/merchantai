'use client';

import type { PaymentContainer } from '@/actions/inventory';
import { Select } from '@/components/ui/select';

// Type → human label (matches the treasury panel vocabulary).
const TYPE_LABEL: Record<string, string> = {
  caja: 'Caja',
  caja_fuerte: 'Caja fuerte',
  banco: 'Banco',
};

/**
 * Presentational selector for treasury containers.
 *
 * Receives a pre-filtered list of active containers (caja | caja_fuerte | banco;
 * 'transito' is excluded at the action layer). Renders a Select showing each
 * container's name with its type as context. Used in EntryModal for the
 * pay-at-entry flow (SC-2.4, REQ-3.5).
 */
export function ContainerSelector({
  accounts,
  value,
  onChange,
  disabled,
}: {
  accounts: PaymentContainer[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      placeholder="Seleccioná un contenedor"
      options={[
        { value: '', label: 'Seleccioná un contenedor', disabled: true },
        ...accounts.map(a => ({
          value: a.id,
          label: `${a.name} (${TYPE_LABEL[a.type] ?? a.type})`,
        })),
      ]}
    />
  );
}
