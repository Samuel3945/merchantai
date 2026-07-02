import { setRequestLocale } from 'next-intl/server';
import { getTopUpPackages } from '@/actions/topup-packages';
import { CreditPricingClient } from '@/features/platform/CreditPricingClient';

export const dynamic = 'force-dynamic';

export default async function PlatformCreditosPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const packages = await getTopUpPackages();

  return <CreditPricingClient packages={packages} />;
}
