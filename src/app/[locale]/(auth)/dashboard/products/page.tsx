import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { getAppSetting } from '@/actions/app-settings';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { listProducts } from '@/features/products/actions';
import { ProductsClient } from '@/features/products/ProductsClient';
import { recategorizeForContext } from '@/features/products/recategorize';
import { recomputeAiContextIfShifted } from '@/libs/ai-context';
import { recomputeBusinessProfileIfStale } from '@/libs/business-profile';

export default async function DashboardProductsPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const { orgId } = await auth();

  // Refresh analytics + AI business context BEFORE the listing, so a context
  // shift can re-categorize the catalog and the table renders the new
  // categories. On routine loads this is a couple of gated/cheap SELECTs; the
  // expensive LLM inference + re-categorization only fire on a real shift in the
  // shape of the business. All three swallow their own errors.
  if (orgId) {
    await recomputeBusinessProfileIfStale(orgId);
    const shift = await recomputeAiContextIfShifted(orgId);
    if (shift.shifted && shift.context) {
      await recategorizeForContext(orgId, shift.context);
    }
  }

  const [initial, sellByWeight, wholesale, perishable]
    = await Promise.all([
      listProducts(),
      getAppSetting('features.sell_by_weight'),
      getAppSetting('features.wholesale'),
      getAppSetting('features.perishable'),
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
