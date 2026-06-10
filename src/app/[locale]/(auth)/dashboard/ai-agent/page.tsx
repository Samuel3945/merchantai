import { setRequestLocale } from 'next-intl/server';
import { getSmartStockSettings } from '@/actions/smart-stock';
import { AgentPersonaSection } from '@/features/ai-agent/AgentPersonaSection';
import { ChannelsSection } from '@/features/ai-agent/ChannelsSection';
import { SmartModelsSection } from '@/features/ai-agent/SmartModelsSection';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardAiAgentPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const smartStock = await getSmartStockSettings();

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

        <ChannelsSection />
      </div>
    </>
  );
}

export const dynamic = 'force-dynamic';
