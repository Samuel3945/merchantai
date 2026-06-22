import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { getSmartStockSettings } from '@/actions/smart-stock';
import { listWhatsAppChannels } from '@/actions/whatsapp-channels';
import { AgentPersonaSection } from '@/features/ai-agent/AgentPersonaSection';
import { ChannelsSection } from '@/features/ai-agent/ChannelsSection';
import { SmartModelsSection } from '@/features/ai-agent/SmartModelsSection';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { evolutionConfigured } from '@/libs/evolution';

export default async function DashboardAiAgentPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // AI preview is a per-org flag the operator flips from /platform; default OFF.
  // Guard the route so a direct hit bounces when AI isn't enabled for the org.
  const aiSetting = await getAppSetting('modules.ai');
  if (aiSetting.value !== 'true') {
    redirect('/dashboard');
  }

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
        />
      </div>
    </>
  );
}

export const dynamic = 'force-dynamic';
