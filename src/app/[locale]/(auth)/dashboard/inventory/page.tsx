import { setRequestLocale } from 'next-intl/server';
import { getInventoryView } from '@/actions/inventory';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { InventoryClient } from '@/features/inventory/InventoryClient';

export default async function DashboardInventoryPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const view = await getInventoryView();

  return (
    <>
      <TitleBar
        title="Inventario"
        description="Stock, lotes FIFO, entradas, salidas y vencimientos."
      />
      <InventoryClient initialView={view} />
    </>
  );
}

export const dynamic = 'force-dynamic';
