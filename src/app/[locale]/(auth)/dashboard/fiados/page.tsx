import { setRequestLocale } from 'next-intl/server';
import { getPendingFiados } from '@/actions/fiados';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { FiadosClient } from '@/features/fiados/FiadosClient';

export default async function DashboardFiadosPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const initial = await getPendingFiados();

  return (
    <>
      <TitleBar
        title="Fiados"
        description="Clientes con saldo pendiente. Cobra, abona o marca como pagado."
      />
      <FiadosClient initial={initial} />
    </>
  );
}

export const dynamic = 'force-dynamic';
