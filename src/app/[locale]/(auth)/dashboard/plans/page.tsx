import { setRequestLocale } from 'next-intl/server';
import { currentPlan } from '@/actions/plans';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { PlansClient } from '@/features/plans/PlansClient';

export default async function DashboardPlansPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const snapshot = await currentPlan();

  return (
    <>
      <TitleBar
        title="Planes y consumo"
        description="Elige el plan que se ajusta a tu operación. Compra paquetes extra de requests cuando lo necesites."
      />
      <PlansClient initialSnapshot={snapshot} />
    </>
  );
}

export const dynamic = 'force-dynamic';
