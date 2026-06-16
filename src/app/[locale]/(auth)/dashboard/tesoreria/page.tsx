import { setRequestLocale } from 'next-intl/server';
import { listPaymentMethods } from '@/actions/payment-methods';
import { getTreasury, listTreasuryAccounts } from '@/actions/treasury';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { SummaryCards } from '@/features/treasury/SummaryCards';
import { TreasuryConsole } from '@/features/treasury/TreasuryConsole';

export default async function TesoreriaPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [treasury, treasuryAccountRows, methods] = await Promise.all([
    getTreasury().catch(() => []),
    listTreasuryAccounts().catch(() => []),
    listPaymentMethods({ activeOnly: true }).catch(() => []),
  ]);

  // Header total = Σ all balances from the single getTreasuryPosition call.
  const totalEmpresa = treasury.reduce((acc, a) => acc + a.balance, 0);

  return (
    <>
      <TitleBar
        title="Tesorería"
        description="Todo el dinero de la empresa en un solo lugar."
      />

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
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
