import { setRequestLocale } from 'next-intl/server';
import { listRecentBroadcasts } from '@/actions/platform-broadcast';
import { BroadcastClient } from '@/features/platform/BroadcastClient';

export const dynamic = 'force-dynamic';

export default async function PlatformAlertsPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const recent = await listRecentBroadcasts();

  return <BroadcastClient recent={recent} />;
}
