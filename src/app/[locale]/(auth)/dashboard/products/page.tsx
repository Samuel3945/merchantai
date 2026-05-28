import { setRequestLocale } from 'next-intl/server';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { listProducts } from '@/features/products/actions';
import { ProductsClient } from '@/features/products/ProductsClient';

export default async function DashboardProductsPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const initial = await listProducts();

  return (
    <>
      <TitleBar
        title="Products"
        description="Manage your catalog: prices, stock, barcodes and status."
      />
      <ProductsClient initial={initial} />
    </>
  );
}

export const dynamic = 'force-dynamic';
