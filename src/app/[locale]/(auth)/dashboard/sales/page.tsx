import { setRequestLocale } from 'next-intl/server';
import { listSales } from '@/actions/sales';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { SalesClient } from '@/features/sales/SalesClient';

const DEFAULT_PAGE_SIZE = 25;

export default async function DashboardSalesPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const initial = await listSales({ limit: DEFAULT_PAGE_SIZE, offset: 0 });

  return (
    <>
      <TitleBar
        title="Ventas"
        description="Consulta, filtra y audita las ventas completadas."
      />
      <SalesClient initial={initial} pageSize={DEFAULT_PAGE_SIZE} />
    </>
  );
}

export const dynamic = 'force-dynamic';
