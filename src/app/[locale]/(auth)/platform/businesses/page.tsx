import { setRequestLocale } from 'next-intl/server';
import { listPlatformOrgs } from '@/actions/platform-orgs';
import { BusinessesDirectoryClient } from '@/features/platform/BusinessesDirectoryClient';

export const dynamic = 'force-dynamic';

export default async function PlatformBusinessesPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const orgs = await listPlatformOrgs();

  return <BusinessesDirectoryClient orgs={orgs} />;
}
