import { setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import { TitleBar } from '@/features/dashboard/TitleBar';

const reports = [
  {
    href: '/dashboard/reports/ventas-periodo',
    title: 'Ventas por período',
    description: 'Total, conteo, ticket promedio, ganancia y margen agrupado por día.',
  },
  {
    href: '/dashboard/reports/ventas-cajero',
    title: 'Ventas por cajero',
    description: 'Desglose de ventas atribuidas a cada cajero.',
  },
  {
    href: '/dashboard/reports/ventas-metodo',
    title: 'Ventas por método de pago',
    description: 'Distribución de ventas por efectivo, transferencia, tarjeta, fiado, etc.',
  },
  {
    href: '/dashboard/reports/top-productos',
    title: 'Top productos',
    description: 'Productos con mayor ingreso, cantidad vendida y margen.',
  },
  {
    href: '/dashboard/reports/analisis-caja',
    title: 'Análisis de caja',
    description: 'Sesiones cerradas, diferencias y alertas de fraude.',
  },
  {
    href: '/dashboard/reports/inventario',
    title: 'Inventario valorizado',
    description: 'Valor del inventario, productos agotados y bajos de stock por categoría.',
  },
  {
    href: '/dashboard/reports/fiados',
    title: 'Fiados',
    description: 'Total pendiente, desglose por cliente y antigüedad.',
  },
  {
    href: '/dashboard/reports/perdidas',
    title: 'Pérdidas (mermas)',
    description: 'Productos perdidos, dañados o vencidos y su costo.',
  },
];

export default async function ReportsPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  return (
    <>
      <TitleBar
        title="Reportes"
        description="Selecciona un reporte para visualizar y exportar."
      />
      <div className="
        grid grid-cols-1 gap-4
        sm:grid-cols-2
        lg:grid-cols-3
      "
      >
        {reports.map(r => (
          <Link
            key={r.href}
            href={r.href}
            className="
              group rounded-lg border bg-background p-5 shadow-xs
              transition-colors
              hover:border-primary/50 hover:bg-accent/30
            "
          >
            <div className="
              text-sm font-semibold
              group-hover:text-primary
            "
            >
              {r.title}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {r.description}
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

export const dynamic = 'force-dynamic';
