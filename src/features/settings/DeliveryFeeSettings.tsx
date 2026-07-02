'use client';

import { useState } from 'react';
import { SelectField, TextField } from './fields';
import { useSettingSave } from './useSettingSave';

export type DeliveryFeeType = 'none' | 'fixed' | 'percent';

// How the delivery fee is treated at settlement (P2-B):
//   'revenue'     — store income; when paid in cash it lands in the same caja
//                   session as the sale so the arqueo stays exact.
//   'courier_tip' — belongs to the courier (fixed wage), never store revenue and
//                   never in the caja; only noted on the order timeline.
export type DeliveryFeeMode = 'revenue' | 'courier_tip';

export type DeliveryFeeSettingsValues = {
  delivery_fee_type: DeliveryFeeType;
  delivery_fee_value: string;
  // Empty string means "no threshold configured" (free shipping is off).
  delivery_free_above: string;
  delivery_fee_mode: DeliveryFeeMode;
};

const TYPE_OPTIONS: ReadonlyArray<{ value: DeliveryFeeType; label: string }> = [
  { value: 'none', label: 'Sin costo de envío' },
  { value: 'fixed', label: 'Monto fijo' },
  { value: 'percent', label: 'Porcentaje del subtotal' },
];

const MODE_OPTIONS: ReadonlyArray<{ value: DeliveryFeeMode; label: string }> = [
  { value: 'revenue', label: 'Ganancia del negocio (entra a la caja)' },
  { value: 'courier_tip', label: 'Propina del domiciliario (no entra a la caja)' },
];

// Small card rendered inside Ajustes → Domicilios, above the delivery-photo
// evidence toggle. The "Domicilios" module toggle itself stays in Ajustes →
// Módulos; only this fee config lives here. Persists via the same
// app_settings mechanism as every other tab (useSettingSave → setAppSetting)
// — see libs/delivery-fee.ts for the server-side reader + the pure fee
// computation.
export function DeliveryFeeSettings({ initial }: { initial: DeliveryFeeSettingsValues }) {
  const { save } = useSettingSave();
  const [type, setType] = useState<DeliveryFeeType>(initial.delivery_fee_type);

  return (
    <div className="space-y-3 rounded-md border border-border bg-background p-4">
      <div>
        <div className="text-sm font-medium">Costo de envío (Domicilios)</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Define cómo se cobra el domicilio. El costo siempre lo calcula el
          servidor — nunca lo decide el asistente de WhatsApp.
        </p>
      </div>

      <SelectField
        id="delivery_fee_type"
        label="Tipo de cobro"
        initial={initial.delivery_fee_type}
        options={TYPE_OPTIONS}
        onCommit={(v) => {
          setType(v);
          save('delivery_fee_type', v, { notifyConfigChange: true });
        }}
      />

      {type !== 'none' && (
        <TextField
          id="delivery_fee_value"
          label={type === 'percent' ? 'Porcentaje (%)' : 'Monto fijo'}
          type="number"
          initial={initial.delivery_fee_value || '0'}
          placeholder={type === 'percent' ? '10' : '5000'}
          hint={
            type === 'percent'
              ? 'Ej: 10 = 10% del subtotal del pedido.'
              : 'Valor en pesos que se cobra por domicilio.'
          }
          onCommit={(v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) {
              return;
            }
            save('delivery_fee_value', String(n), { notifyConfigChange: true });
          }}
        />
      )}

      {type !== 'none' && (
        <TextField
          id="delivery_free_above"
          label="Envío gratis desde (opcional)"
          type="number"
          initial={initial.delivery_free_above}
          placeholder="50000"
          hint="Si el subtotal alcanza este monto, el envío es gratis. Déjalo vacío para no aplicar."
          onCommit={(v) => {
            const trimmed = v.trim();
            if (trimmed === '') {
              save('delivery_free_above', '', { notifyConfigChange: true });
              return;
            }
            const n = Number(trimmed);
            if (!Number.isFinite(n) || n < 0) {
              return;
            }
            save('delivery_free_above', String(n), { notifyConfigChange: true });
          }}
        />
      )}

      {type !== 'none' && (
        <SelectField
          id="delivery_fee_mode"
          label="¿A quién pertenece el domicilio?"
          initial={initial.delivery_fee_mode}
          options={MODE_OPTIONS}
          hint="Ganancia: el domicilio entra a la caja como ingreso. Propina: es del domiciliario y no se suma a la caja."
          onCommit={(v) => {
            save('delivery_fee_mode', v, { notifyConfigChange: true });
          }}
        />
      )}
    </div>
  );
}
