import { setRequestLocale } from 'next-intl/server';
import { listPaymentContainers } from '@/actions/inventory';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { listOpenPayablesAction } from '@/features/suppliers/actions';
import { PayablesClient } from '@/features/suppliers/PayablesClient';

/**
 * "Compras por pagar" page — lists all open/partial supplier payables for the
 * organization and allows full or partial payment from any active treasury
 * container.
 *
 * Satisfies: REQ-6.1, REQ-6.2, REQ-6.5, REQ-6.6, SC-5.1, SC-5.5.
 */
export default async function SupplierPayablesPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [payables, accounts] = await Promise.all([
    listOpenPayablesAction(),
    listPaymentContainers(),
  ]);

  return (
    <>
      <TitleBar
        title="Compras por pagar"
        description="Pagos pendientes de compras de inventario a proveedores."
      />
      <PayablesClient initial={payables} accounts={accounts} />
    </>
  );
}

export const dynamic = 'force-dynamic';
