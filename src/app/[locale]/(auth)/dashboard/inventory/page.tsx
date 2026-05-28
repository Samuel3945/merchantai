import { setRequestLocale } from 'next-intl/server';
import { getInventoryProducts } from '@/actions/inventory';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { InventoryClient } from '@/features/inventory/InventoryClient';

export default async function DashboardInventoryPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const products = await getInventoryProducts();

  return (
    <>
      <TitleBar
        title="Inventario"
        description="Stock actual, movimientos, entradas, salidas y recomendaciones IA."
      />
      <InventoryClient initialProducts={products} />
    </>
  );
}

export const dynamic = 'force-dynamic';
