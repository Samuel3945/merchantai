import { setRequestLocale } from 'next-intl/server';
import { getCourierWalletsAction } from '@/actions/courier-wallet';
import { getTimeline, getTreasury, listGastosAction, listTreasuryAccounts } from '@/actions/treasury';
import {
  getHandoverStatusForSessionsAction,
  listPendingHandoversAction,
} from '@/actions/treasury-placement';
import { CourierPocketsCard } from '@/features/treasury/CourierPocketsCard';
import { GastosHistory } from '@/features/treasury/GastosHistory';
import { TreasuryHero } from '@/features/treasury/TreasuryHero';
import { TreasuryHistory } from '@/features/treasury/TreasuryHistory';
import { TreasuryPageClient } from '@/features/treasury/TreasuryPageClient';
import { sumTransito } from '@/features/treasury/utils';

export default async function TesoreriaPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // Default gastos range: current calendar month
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const monthEnd = new Date().toISOString().slice(0, 10);

  // Run the payment-method → treasury backfill FIRST (it lives inside
  // listTreasuryAccounts via ensurePaymentMethodAccounts) so a transfer method's
  // auto-created account is visible in the position on THIS render, not only
  // after a refresh.
  const treasuryAccountRows = await listTreasuryAccounts().catch(() => []);
  const [treasury, timelineEntries, initialGastos] = await Promise.all([
    getTreasury().catch(() => []),
    getTimeline(50).catch(() => []),
    listGastosAction({ start: monthStart, end: monthEnd }).catch(() => ({ rows: [], total: 0 })),
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

  // Bolsillo de domiciliarios: solo aparece si hay domiciliarios activos.
  const courierWallets = await getCourierWalletsAction().catch(() => []);
  // "En la calle" = efectivo de la empresa en manos de los domiciliarios. Es
  // plata real, solo que fuera del local → se SUMA al total de empresa.
  const enLaCalle = courierWallets.reduce((acc, w) => acc + w.balance, 0);
  const totalConCalle = totalEmpresa + enLaCalle;

  return (
    <div className="flex flex-col gap-[22px]">
      {/* 1. Hero: title + big total + buckets */}
      <TreasuryHero
        accounts={treasury}
        total={totalConCalle}
        pendingCount={pendingCount}
        enLaCalle={enLaCalle}
        courierCount={courierWallets.length}
      />

      {/* 2-4. Interactive sections: PorUbicar + MoneyFlow + TreasuryActions */}
      {/* Wrapped in TreasuryPageClient to share wizard/slideover state */}
      <TreasuryPageClient
        accounts={treasury}
        accountRows={treasuryAccountRows}
        pendingHandovers={pendingHandovers}
        bankAccounts={bankRows}
        cajaFuerteAccounts={cajaFuerteRows}
        total={totalEmpresa}
        sinUbicar={sinUbicar}
        pendingCount={pendingCount}
      />

      {/* Bolsillo de domiciliarios — dinero en la calle (solo si hay activos) */}
      {courierWallets.length > 0 && (
        <CourierPocketsCard wallets={courierWallets} />
      )}

      {/* 5. Historial de tesorería */}
      <TreasuryHistory entries={timelineEntries} />

      {/* 6. Historial de gastos — unified across all origins */}
      <GastosHistory
        initialRows={initialGastos.rows}
        initialTotal={initialGastos.total}
        initialStart={monthStart}
        initialEnd={monthEnd}
      />
    </div>
  );
}

export const dynamic = 'force-dynamic';
