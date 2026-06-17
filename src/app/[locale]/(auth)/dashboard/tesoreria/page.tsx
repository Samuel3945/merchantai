import { setRequestLocale } from 'next-intl/server';
import { listPaymentMethods } from '@/actions/payment-methods';
import { getTimeline, getTreasury, listTreasuryAccounts } from '@/actions/treasury';
import {
  getHandoverStatusForSessionsAction,
  listPendingHandoversAction,
} from '@/actions/treasury-placement';
import { MoneyFlow } from '@/features/treasury/MoneyFlow';
import { PorUbicar } from '@/features/treasury/PorUbicar';
import { TreasuryActions } from '@/features/treasury/TreasuryActions';
import { TreasuryHero } from '@/features/treasury/TreasuryHero';
import { TreasuryHistory } from '@/features/treasury/TreasuryHistory';
import { sumTransito } from '@/features/treasury/utils';

export default async function TesoreriaPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [treasury, treasuryAccountRows, _methods, timelineEntries] = await Promise.all([
    getTreasury().catch(() => []),
    listTreasuryAccounts().catch(() => []),
    listPaymentMethods({ activeOnly: true }).catch(() => []),
    getTimeline(50).catch(() => []),
  ]);

  const totalEmpresa = treasury.reduce((acc, a) => acc + a.balance, 0);
  const sinUbicar = sumTransito(treasury);
  const hasTransito = treasury.some(a => a.type === 'transito' && a.balance > 0);

  // Collect session IDs for R7 "entregado" label query.
  const cajaSessionIds = treasury
    .filter(a => a.type === 'caja' && a.sessionId)
    .map(a => a.sessionId!);

  const [pendingHandoversResult] = await Promise.all([
    hasTransito
      ? listPendingHandoversAction().catch(() => ({ ok: false as const, error: '' }))
      : Promise.resolve({ ok: true as const, data: [] }),
    // R7 "entregado" label — kept for correctness but not rendered in View B (slice B).
    cajaSessionIds.length > 0
      ? getHandoverStatusForSessionsAction(cajaSessionIds).catch(() => ({
          ok: false as const,
          error: '',
        }))
      : Promise.resolve({ ok: true as const, data: {} as Record<string, boolean> }),
  ]);

  const pendingHandovers = pendingHandoversResult.ok ? pendingHandoversResult.data : [];
  const pendingCount = pendingHandovers.length;

  // Account rows split for the placement queue
  const bankRows = treasuryAccountRows.filter(r => r.type === 'banco');
  const cajaFuerteRows = treasuryAccountRows.filter(r => r.type === 'caja_fuerte');

  return (
    <div className="flex flex-col gap-[22px]">
      {/* 1. Hero: title + big total + 3 buckets */}
      <TreasuryHero
        accounts={treasury}
        total={totalEmpresa}
        pendingCount={pendingCount}
      />

      {/* 2. Plata por ubicar (only when pending > 0) */}
      {pendingCount > 0 && (
        <PorUbicar
          pendingHandovers={pendingHandovers}
          bankAccounts={bankRows}
          cajaFuerteAccounts={cajaFuerteRows}
        />
      )}

      {/* 3. Dónde está la plata — flow diagram */}
      <MoneyFlow
        accounts={treasury}
        total={totalEmpresa}
        sinUbicar={sinUbicar}
        pendingCount={pendingCount}
      />

      {/* 4. Action buttons row */}
      <TreasuryActions accountRows={treasuryAccountRows} />

      {/* 5. Historial de tesorería */}
      <TreasuryHistory entries={timelineEntries} />
    </div>
  );
}

export const dynamic = 'force-dynamic';
