import { setRequestLocale } from 'next-intl/server';
import { currentPlan } from '@/actions/plans';
import { getSmartStockSettings } from '@/actions/smart-stock';
import { AiAgentClient } from '@/features/ai-agent/AiAgentClient';
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
        description="Consulta tus ventas con el Sales Manager o atiende clientes con Customer Service."
      />
      <AiAgentClient initialSnapshot={snapshot} />
      {/* Siempre visible: bloqueado como upsell para orgs que no son Pro. */}
      <SmartModelsSection initialSettings={smartStock} />
    </>
  );
}

export const dynamic = 'force-dynamic';
