import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { getPlatformOrgDetail } from '@/actions/platform-orgs';
import { listPlatformPlans } from '@/actions/platform-plans';
import { BusinessCockpitClient } from '@/features/platform/BusinessCockpitClient';

export const dynamic = 'force-dynamic';

export default async function PlatformBusinessDetailPage(props: {
  params: Promise<{ locale: string; orgId: string }>;
}) {
  const { locale, orgId } = await props.params;
  setRequestLocale(locale);

  const [org, plans] = await Promise.all([
    getPlatformOrgDetail(orgId),
    listPlatformPlans(),
  ]);

  if (!org) {
    notFound();
  }

  const planOptions = plans
    .filter(p => !p.isArchived)
    .map(p => ({ slug: p.slug, name: p.name, isPublic: p.isPublic }));

  return <BusinessCockpitClient org={org} planOptions={planOptions} />;
}
