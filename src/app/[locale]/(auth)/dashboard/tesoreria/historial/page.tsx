import { setRequestLocale } from 'next-intl/server';
import { getTimelinePage, listTreasuryAccounts } from '@/actions/treasury';
import { TreasuryTimelineFull } from '@/features/treasury/TreasuryTimelineFull';

const PAGE_SIZE = 25;

export default async function TesoreriaHistorialPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [firstPage, accountRows] = await Promise.all([
    getTimelinePage({ page: 1, pageSize: PAGE_SIZE }).catch(() => ({
      rows: [],
      total: 0,
    })),
    listTreasuryAccounts().catch(() => []),
  ]);

  return (
    <TreasuryTimelineFull
      initialRows={firstPage.rows}
      initialTotal={firstPage.total}
      pageSize={PAGE_SIZE}
      accounts={accountRows.map(a => ({ id: a.id, name: a.name }))}
    />
  );
}

export const dynamic = 'force-dynamic';
