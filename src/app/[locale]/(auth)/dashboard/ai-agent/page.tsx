import { setRequestLocale } from 'next-intl/server';
import { currentPlan } from '@/actions/plans';
import { AiAgentClient } from '@/features/ai-agent/AiAgentClient';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardAiAgentPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const snapshot = await currentPlan();

  return (
    <>
      <TitleBar
        title="AI Agent"
        description="Consulta tus ventas con el Sales Manager o atiende clientes con Customer Service."
      />
      <AiAgentClient initialSnapshot={snapshot} />
    </>
  );
}

export const dynamic = 'force-dynamic';
