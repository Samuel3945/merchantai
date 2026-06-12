'use client';

import type { WhatsAppChannelRow } from '@/actions/whatsapp-channels';
import { RadioTowerIcon } from 'lucide-react';
import { WhatsAppChannelsPanel } from '@/features/whatsapp/WhatsAppChannelsPanel';

// "Canales" — where the agent connects to the outside world. Today that means
// WhatsApp via Evolution instances (real, persisted). The previous local-only
// mock (capabilities/hours per channel, with a disabled "Próximamente" connect)
// was a Tiendademo port wired to nothing, so it was removed in favor of the real
// connection. Per-channel capabilities can return once they drive the agent.
export function ChannelsSection({
  isAdmin,
  whatsappChannels,
  evolutionConfigured,
  whatsappWebhookConfigured,
}: {
  isAdmin: boolean;
  whatsappChannels: WhatsAppChannelRow[];
  evolutionConfigured: boolean;
  whatsappWebhookConfigured: boolean;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <RadioTowerIcon className="size-5 text-brand" />
          Canales
        </h2>
        <p className="text-sm text-muted-foreground">
          Conectá los canales por donde responde la IA.
        </p>
      </div>

      {isAdmin
        ? (
            <WhatsAppChannelsPanel
              initialChannels={whatsappChannels}
              configured={evolutionConfigured}
              webhookConfigured={whatsappWebhookConfigured}
            />
          )
        : (
            <div className="
              rounded-md border border-dashed bg-background p-8 text-center
              text-sm text-muted-foreground
            "
            >
              Solo un administrador puede conectar canales de WhatsApp.
            </div>
          )}
    </section>
  );
}
