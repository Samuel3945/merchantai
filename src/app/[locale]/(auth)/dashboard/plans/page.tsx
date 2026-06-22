import { setRequestLocale } from 'next-intl/server';
import { getAppSetting } from '@/actions/app-settings';
import { currentPlan, listPublicPlans } from '@/actions/plans';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { PlansClient } from '@/features/plans/PlansClient';

export default async function DashboardPlansPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [snapshot, plans, aiSetting] = await Promise.all([
    currentPlan(),
    listPublicPlans(),
    getAppSetting('modules.ai'),
  ]);
  // AI preview gates the AI-credit consumption section below; default OFF.
  const aiEnabled = aiSetting.value === 'true';

  return (
    <>
      <TitleBar
        title="Planes y consumo"
        description="Elige el plan que se ajusta a tu operación. Compra paquetes extra de requests cuando lo necesites."
      />
      <PlansClient
        initialSnapshot={snapshot}
        plans={plans}
        aiEnabled={aiEnabled}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
