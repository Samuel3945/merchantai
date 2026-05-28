import { setRequestLocale } from 'next-intl/server';
import { listCustomers } from '@/features/customers/actions';
import { CustomersClient } from '@/features/customers/CustomersClient';
import { TitleBar } from '@/features/dashboard/TitleBar';

export default async function DashboardCustomersPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const initial = await listCustomers();

  return (
    <>
      <TitleBar
        title="Customers"
        description="Tu CRM: clientes, contacto, dirección y compras acumuladas."
      />
      <CustomersClient initial={initial} />
    </>
  );
}

export const dynamic = 'force-dynamic';
