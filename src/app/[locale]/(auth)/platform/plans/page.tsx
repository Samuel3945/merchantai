import { setRequestLocale } from 'next-intl/server';
import { listPlatformPlans } from '@/actions/platform-plans';
import { PlansStudioClient } from '@/features/platform/PlansStudioClient';

export const dynamic = 'force-dynamic';

export default async function PlatformPlansPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const plans = await listPlatformPlans();

  return <PlansStudioClient plans={plans} />;
}
