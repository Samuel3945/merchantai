import { setRequestLocale } from 'next-intl/server';
import { getSalesSummary, listSales } from '@/actions/sales';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { SalesClient } from '@/features/sales/SalesClient';

const DEFAULT_PAGE_SIZE = 25;

export default async function DashboardSalesPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [initial, initialSummary] = await Promise.all([
    listSales({ limit: DEFAULT_PAGE_SIZE, offset: 0 }),
    getSalesSummary({}),
  ]);

  return (
    <>
      <TitleBar
        title="Ventas"
        description="Consulta, filtra y audita las ventas completadas."
      />
      <SalesClient
        initial={initial}
        initialSummary={initialSummary}
        pageSize={DEFAULT_PAGE_SIZE}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
