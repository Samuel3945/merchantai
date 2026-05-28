'use client';

import { MaskedField, TextField } from './fields';
import { useSettingSave } from './useSettingSave';

export type IntegrationsTabValues = {
  whatsapp_business_token: string;
  whatsapp_phone_number_id: string;
  wompi_public_key: string;
  wompi_private_key: string;
  openai_api_key: string;
};

export function IntegrationsTab({
  initial,
}: {
  initial: IntegrationsTabValues;
}) {
  const { save } = useSettingSave();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Integraciones</h2>
        <p className="text-sm text-muted-foreground">
          Conecta servicios externos. Las llaves se muestran enmascaradas
          después de guardarlas.
        </p>
      </div>

      <section className="space-y-4 rounded-md border border-border p-4">
        <div>
          <h3 className="text-sm font-semibold">WhatsApp Business API</h3>
          <p className="text-xs text-muted-foreground">
            Para envío de notificaciones a clientes desde tu número verificado.
          </p>
        </div>
        <MaskedField
          id="whatsapp_business_token"
          label="Token de acceso"
          initial={initial.whatsapp_business_token}
          placeholder="EAAG..."
          onCommit={v => save('whatsapp_business_token', v)}
        />
        <TextField
          id="whatsapp_phone_number_id"
          label="Phone Number ID"
          initial={initial.whatsapp_phone_number_id}
          placeholder="123456789012345"
          onCommit={v => save('whatsapp_phone_number_id', v.trim())}
        />
      </section>

      <section className="space-y-4 rounded-md border border-border p-4">
        <div>
          <h3 className="text-sm font-semibold">Wompi</h3>
          <p className="text-xs text-muted-foreground">
            Pasarela de pagos para cobros con tarjeta y PSE.
          </p>
        </div>
        <MaskedField
          id="wompi_public_key"
          label="Llave pública"
          initial={initial.wompi_public_key}
          placeholder="pub_prod_..."
          onCommit={v => save('wompi_public_key', v)}
        />
        <MaskedField
          id="wompi_private_key"
          label="Llave privada"
          initial={initial.wompi_private_key}
          placeholder="prv_prod_..."
          onCommit={v => save('wompi_private_key', v)}
        />
      </section>

      <section className="space-y-4 rounded-md border border-border p-4">
        <div>
          <h3 className="text-sm font-semibold">OpenAI (BYOK)</h3>
          <p className="text-xs text-muted-foreground">
            Opcional. Si configuras tu propia llave, las funciones de IA del POS
            consumirán tu cuota directamente en lugar de la nuestra.
          </p>
        </div>
        <MaskedField
          id="openai_api_key"
          label="API Key"
          initial={initial.openai_api_key}
          placeholder="sk-..."
          onCommit={v => save('openai_api_key', v)}
        />
      </section>
    </div>
  );
}
