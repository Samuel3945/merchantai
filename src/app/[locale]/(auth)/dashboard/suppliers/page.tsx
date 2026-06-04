import { setRequestLocale } from 'next-intl/server';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { getSupplierKpis, listSuppliers } from '@/features/suppliers/actions';
import { SuppliersClient } from '@/features/suppliers/SuppliersClient';

export default async function DashboardSuppliersPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [initial, kpis] = await Promise.all([
    listSuppliers(),
    getSupplierKpis(),
  ]);

  return (
    <>
      <TitleBar
        title="Proveedores"
        description="Gestiona los proveedores de productos y servicios del negocio."
      />
      <SuppliersClient initial={initial} kpis={kpis} />
    </>
  );
}

export const dynamic = 'force-dynamic';
