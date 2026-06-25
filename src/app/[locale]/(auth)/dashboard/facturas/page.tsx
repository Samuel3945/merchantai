import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAppSetting } from '@/actions/app-settings';
import { listInvoices } from '@/actions/einvoice';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { InvoicesClient } from '@/features/einvoice/InvoicesClient';

export default async function FacturasPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  // E-invoicing is operator-gated (modules.facturas, default OFF). Block direct
  // navigation when it is not enabled for this org.
  const facturasSetting = await getAppSetting('modules.facturas');
  if (facturasSetting.value !== 'true') {
    redirect('/dashboard');
  }

  const initialTab = 'pending' as const;
  const initialData = await listInvoices(initialTab);

  return (
    <>
      <TitleBar
        title="Facturas"
        description="Estado de cada factura electrónica. Las pendientes se emiten cuando conectás un proveedor en Ajustes → Fiscal."
      />
      <InvoicesClient initialData={initialData} initialTab={initialTab} />
    </>
  );
}

export const dynamic = 'force-dynamic';
