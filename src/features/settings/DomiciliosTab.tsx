'use client';

import type { DeliveryFeeSettingsValues } from './DeliveryFeeSettings';
import { useState } from 'react';
import { DeliveryFeeSettings } from './DeliveryFeeSettings';
import { ToggleRow } from './fields';
import { useSettingSave } from './useSettingSave';

export type DomiciliosTabValues = DeliveryFeeSettingsValues & {
  // The "¿Trabaja con domicilio?" master toggle. Persisted as the delivery
  // module flag (modules.delivery) so nav/dashboard gating stays in sync — this
  // is the only place it is edited now that the Módulos tab is gone.
  'modules.delivery': boolean;
  'delivery_require_photo': boolean;
};

// Own tab (Ajustes → Domicilios), gated the same way as the AI preview (only
// visible when AI preview is enabled for the org). Sequential flow: the master
// "¿Trabaja con domicilio?" toggle reveals the fee config + delivery-photo
// preference; turning it off hides everything below reactively.
export function DomiciliosTab({ initial }: { initial: DomiciliosTabValues }) {
  const { save } = useSettingSave();
  const [worksWithDelivery, setWorksWithDelivery] = useState(
    initial['modules.delivery'],
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Domicilios</h2>
        <p className="text-sm text-muted-foreground">
          Indica si tu negocio trabaja con domicilios. Al activarlo podrás
          configurar el cobro de envío y qué se exige para confirmar la entrega.
        </p>
      </div>

      <ToggleRow
        label="¿Trabaja con domicilio?"
        description="Actívalo si tu negocio hace entregas a domicilio."
        initial={initial['modules.delivery']}
        onCommit={(v) => {
          setWorksWithDelivery(v);
          save('modules.delivery', v ? 'true' : 'false', {
            notifyConfigChange: true,
          });
        }}
      />

      {worksWithDelivery && (
        <>
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
              label="¿Quieres foto?"
              description="El domiciliario deberá adjuntar una foto de la entrega antes de poder marcar el pedido como entregado."
              initial={initial.delivery_require_photo}
              onCommit={v =>
                save('delivery_require_photo', v ? 'true' : 'false', {
                  notifyConfigChange: true,
                })}
            />
          </div>
        </>
      )}
    </div>
  );
}
