import { setRequestLocale } from 'next-intl/server';
import { currentPlan } from '@/actions/plans';
import { getSmartStockSettings } from '@/actions/smart-stock';
import { AgentPersonaSection } from '@/features/ai-agent/AgentPersonaSection';
import { AiAgentClient } from '@/features/ai-agent/AiAgentClient';
import { ChannelsSection } from '@/features/ai-agent/ChannelsSection';
import { SmartModelsSection } from '@/features/ai-agent/SmartModelsSection';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardAiAgentPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [snapshot, smartStock] = await Promise.all([
    currentPlan(),
    getSmartStockSettings(),
  ]);

  return (
    <>
      <TitleBar
        title="Agente IA"
        description="Define la personalidad de tu agente, conéctalo a tus canales y consulta tus ventas o atiende clientes desde el chat."
      />

      <div className="space-y-10">
        <AgentPersonaSection />

        {/* Chat en vivo — habla con el agente (Sales Manager / Customer Service). */}
        <AiAgentClient initialSnapshot={snapshot} />

        {/* Operación inteligente. Siempre visible: bloqueado como upsell si no es Pro. */}
        <SmartModelsSection initialSettings={smartStock} />

        <ChannelsSection />
      </div>
    </>
  );
}

export const dynamic = 'force-dynamic';
