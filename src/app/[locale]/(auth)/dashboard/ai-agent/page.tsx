import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { getSmartStockSettings } from '@/actions/smart-stock';
import { listWhatsAppChannels } from '@/actions/whatsapp-channels';
import { AgentPersonaSection } from '@/features/ai-agent/AgentPersonaSection';
import { ChannelsSection } from '@/features/ai-agent/ChannelsSection';
import { SmartModelsSection } from '@/features/ai-agent/SmartModelsSection';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { Env } from '@/libs/Env';
import { evolutionConfigured } from '@/libs/evolution';

export default async function DashboardAiAgentPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [{ orgRole }, smartStock] = await Promise.all([
    auth(),
    getSmartStockSettings(),
  ]);

  // WhatsApp channels are admin-only (the action enforces it too).
  const isAdmin = !orgRole || orgRole === 'org:admin';
  const whatsappChannels = isAdmin ? await listWhatsAppChannels() : [];

  return (
    <>
      <TitleBar
        title="Agente IA"
        description="Define la personalidad de tu agente y conéctalo a tus canales."
      />

      <div className="space-y-10">
        <AgentPersonaSection />

        {/* Operación inteligente. Siempre visible: bloqueado como upsell si no es Pro. */}
        <SmartModelsSection initialSettings={smartStock} />

        <ChannelsSection
          isAdmin={isAdmin}
          whatsappChannels={whatsappChannels}
          evolutionConfigured={evolutionConfigured()}
          whatsappWebhookConfigured={Boolean(Env.WHATSAPP_N8N_WEBHOOK_URL)}
        />
      </div>
    </>
  );
}

export const dynamic = 'force-dynamic';
