'use client';

import type { ReturnsReport } from '@/actions/analytics';
import { useEffect, useRef, useState } from 'react';
import { getReturnsAnalysis } from '@/actions/analytics';
import { fmtMoney } from '@/features/reports/format';
import {
  ChartCard,
  DonutChart,
  RankBars,
  StatTile,
} from '@/features/reports/ReportCharts';
import { ReportShell } from '@/features/reports/ReportShell';

const EMPTY: ReturnsReport = {
  totalRefunded: 0,
  returnCount: 0,
  salesCount: 0,
  returnRate: 0,
  byReason: [],
  topProducts: [],
};

const REASON_LABELS: Record<string, string> = {
  wrong_product: 'Producto equivocado',
  damaged: 'Dañado',
  customer_request: 'Pedido del cliente',
  price_error: 'Error de precio',
  duplicate: 'Duplicado',
  other: 'Otro',
};

export default function DevolucionesPage() {
  const [data, setData] = useState<ReturnsReport>(EMPTY);

  return (
    <ReportShell title="Devoluciones">
      {({ start, end }) => (
        <Loader start={start} end={end} onData={setData}>
          <p className="text-sm text-muted-foreground">
            Cuánto y por qué te devuelven. Una tasa alta o un producto que vuelve
            seguido es señal de un problema de calidad, de precio o de proceso que
            te está costando plata.
          </p>

          <div className="
            grid grid-cols-1 gap-3
            sm:grid-cols-3
          "
          >
            <StatTile
              label="Tasa de devolución"
              value={`${data.returnRate.toFixed(1)}%`}
              tone={data.returnRate > 5 ? 'danger' : data.returnRate > 2 ? 'warn' : 'good'}
              hint={`${data.returnCount} de ${data.salesCount} ventas`}
            />
            <StatTile label="Total reembolsado" value={fmtMoney(data.totalRefunded)} tone="danger" />
            <StatTile label="Devoluciones" value={String(data.returnCount)} />
          </div>

          <ChartCard title="Por qué te devuelven">
            <DonutChart
              data={data.byReason.map(r => ({
                label: REASON_LABELS[r.reason] ?? r.reason,
                count: r.count,
              }))}
              nameKey="label"
              valueKey="count"
              money={false}
            />
          </ChartCard>

          <ChartCard
            title="Productos más devueltos"
            description="Si un producto encabeza siempre esta lista, algo pasa con él."
          >
            <RankBars
              data={data.topProducts.slice(0, 10).map(p => ({
                productName: p.productName,
                qty: p.qty,
              }))}
              labelKey="productName"
              valueKey="qty"
              name="Unidades"
              money={false}
            />
          </ChartCard>
        </Loader>
      )}
    </ReportShell>
  );
}

function Loader({
  start,
  end,
  onData,
  children,
}: {
  start: string;
  end: string;
  onData: (data: ReturnsReport) => void;
  children: React.ReactNode;
}) {
  const prev = useRef('');
  useEffect(() => {
    const key = `${start}|${end}`;
    if (key !== prev.current) {
      prev.current = key;
      getReturnsAnalysis(start, end).then(onData).catch(() => onData(EMPTY));
    }
  }, [start, end, onData]);
  return <div className="space-y-4">{children}</div>;
}
