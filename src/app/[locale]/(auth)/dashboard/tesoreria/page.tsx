import { setRequestLocale } from 'next-intl/server';
import { listPaymentMethods } from '@/actions/payment-methods';
import { getTimeline, getTreasury, listTreasuryAccounts } from '@/actions/treasury';
import {
  getPendingHandoversOverview,
  listPendingHandoversAction,
} from '@/actions/treasury-placement';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { SummaryCards } from '@/features/treasury/SummaryCards';
import { TreasuryConsole } from '@/features/treasury/TreasuryConsole';
import { TreasuryTimeline } from '@/features/treasury/TreasuryTimeline';

export default async function TesoreriaPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [treasury, treasuryAccountRows, methods, timelineEntries] = await Promise.all([
    getTreasury().catch(() => []),
    listTreasuryAccounts().catch(() => []),
    listPaymentMethods({ activeOnly: true }).catch(() => []),
    getTimeline(50).catch(() => []),
  ]);

  // Header total = Σ all balances from the single getTreasuryPosition call.
  const totalEmpresa = treasury.reduce((acc, a) => acc + a.balance, 0);

  // Pending handovers: only fetch when there is a transito balance (fast-path).
  const hasTransito = treasury.some(a => a.type === 'transito' && a.balance > 0);

  const [pendingHandoversResult, pendingOverview] = await Promise.all([
    hasTransito
      ? listPendingHandoversAction().catch(() => ({ ok: false as const, error: '' }))
      : Promise.resolve({ ok: true as const, data: [] }),
    getPendingHandoversOverview().catch(() => ({ ok: false as const, error: '' })),
  ]);

  const pendingHandovers = pendingHandoversResult.ok ? pendingHandoversResult.data : [];

  const pendingBadgeTotal
    = pendingOverview.ok && pendingOverview.data.total > 0
      ? pendingOverview.data.total
      : 0;

  return (
    <>
      <TitleBar
        title="Tesorería"
        description="Todo el dinero de la empresa en un solo lugar."
      />

      {/* Sin-ubicar badge — shown when there is outstanding Pendiente balance */}
      {pendingBadgeTotal > 0 && (
        <div className="
          mb-4 flex items-center gap-2 rounded-lg border border-amber-200
          bg-amber-50 px-3 py-2 text-sm text-amber-800
          dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300
        "
        >
          <span className="font-medium">
            {new Intl.NumberFormat('es-CO', {
              style: 'currency',
              currency: 'COP',
              maximumFractionDigits: 0,
            }).format(pendingBadgeTotal)}
          </span>
          <span className="
            text-amber-700
            dark:text-amber-400
          "
          >
            sin ubicar
          </span>
        </div>
      )}

      {/* Header: Dinero total empresa */}
      <div className="mb-6">
        <div className="text-sm font-medium text-muted-foreground">
          Dinero total empresa
        </div>
        <div className="
          mt-1 font-display text-4xl font-semibold tracking-tight tabular-nums
          sm:text-5xl
        "
        >
          {new Intl.NumberFormat('es-CO', {
            style: 'currency',
            currency: 'COP',
            maximumFractionDigits: 0,
          }).format(totalEmpresa)}
        </div>
      </div>

      {/* 3 summary cards — EFECTIVO / BANCOS / EN TRÁNSITO */}
      <div className="mb-8">
        <SummaryCards accounts={treasury} />
      </div>

      {/* Full treasury console — location breakdown + actions */}
      <TreasuryConsole
        accounts={treasury}
        accountRows={treasuryAccountRows}
        transferMethods={methods}
        totalOverride={totalEmpresa}
        pendingHandovers={pendingHandovers}
      />

      {/* Slice C: Financial timeline — read-only movement history */}
      <div className="mt-8">
        <TreasuryTimeline entries={timelineEntries} />
      </div>
    </>
  );
}

export const dynamic = 'force-dynamic';
