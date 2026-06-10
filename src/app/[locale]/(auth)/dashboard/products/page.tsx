import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { getAppSetting } from '@/actions/app-settings';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { listProducts } from '@/features/products/actions';
import { ProductsClient } from '@/features/products/ProductsClient';
import { recomputeBusinessProfileIfStale } from '@/libs/business-profile';

export default async function DashboardProductsPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const { orgId } = await auth();

  // Refresh the platform analytics snapshot opportunistically: it's gated to
  // once per day per org and swallows its own errors, and runs in parallel here
  // so it never adds latency to the page beyond the other loads.
  const [initial, sellByWeight, wholesale, perishable]
    = await Promise.all([
      listProducts(),
      getAppSetting('features.sell_by_weight'),
      getAppSetting('features.wholesale'),
      getAppSetting('features.perishable'),
      orgId ? recomputeBusinessProfileIfStale(orgId) : Promise.resolve(),
    ]);

  return (
    <>
      <TitleBar
        title="Productos"
        description="Gestiona tu catálogo: precios, stock, códigos de barras y estado."
      />
      <ProductsClient
        initial={initial}
        features={{
          sellByWeight: sellByWeight.value === 'true',
          wholesale: wholesale.value === 'true',
          perishable: perishable.value === 'true',
        }}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
