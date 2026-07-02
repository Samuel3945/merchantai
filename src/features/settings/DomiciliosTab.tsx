'use client';

import type { DeliveryFeeSettingsValues } from './DeliveryFeeSettings';
import { DeliveryFeeSettings } from './DeliveryFeeSettings';
import { ToggleRow } from './fields';
import { useSettingSave } from './useSettingSave';

export type DomiciliosTabValues = DeliveryFeeSettingsValues & {
  delivery_require_photo: boolean;
};

// Own tab (Ajustes → Domicilios), gated the same way as the "Domicilios"
// module toggle in Módulos: only visible when AI preview is enabled for the
// org. Holds the fee config (moved here from Módulos, see DeliveryFeeSettings)
// plus delivery-completion evidence preferences.
export function DomiciliosTab({ initial }: { initial: DomiciliosTabValues }) {
  const { save } = useSettingSave();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Domicilios</h2>
        <p className="text-sm text-muted-foreground">
          Configura el cobro de envío y qué se exige para confirmar la
          entrega.
        </p>
      </div>

      <DeliveryFeeSettings initial={initial} />

      <div className="space-y-4 border-t pt-6">
        <div>
          <h2 className="text-lg font-semibold">Evidencia de entrega</h2>
          <p className="text-sm text-muted-foreground">
            Define qué debe registrar el domiciliario antes de cerrar el
            pedido.
          </p>
        </div>

        <ToggleRow
          label="Exigir foto para marcar como entregado"
          description="El domiciliario deberá adjuntar una foto de la entrega antes de poder marcar el pedido como entregado."
          initial={initial.delivery_require_photo}
          onCommit={v =>
            save('delivery_require_photo', v ? 'true' : 'false', {
              notifyConfigChange: true,
            })}
        />
      </div>
    </div>
  );
}
