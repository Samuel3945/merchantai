'use client';

import type { CashFlowReport } from '@/actions/analytics';
import { useEffect, useRef, useState } from 'react';
import { getCashFlow } from '@/actions/analytics';
import { fmtMoney } from '@/features/reports/format';
import {
  ChartCard,
  DonutChart,
  StatTile,
  TrendChart,
} from '@/features/reports/ReportCharts';
import { ReportShell } from '@/features/reports/ReportShell';

const EMPTY: CashFlowReport = {
  income: 0,
  expenses: 0,
  net: 0,
  byType: [],
  daily: [],
};

const TYPE_LABELS: Record<string, string> = {
  sale: 'Ventas',
  deposit: 'Depósitos',
  expense: 'Gastos',
  salary: 'Sueldos',
  inventory_purchase: 'Compra de inventario',
  withdrawal: 'Retiros',
  adjustment: 'Ajustes',
  advance: 'Vales empleados',
};

export default function FlujoCajaPage() {
  const [data, setData] = useState<CashFlowReport>(EMPTY);

  return (
    <ReportShell title="Flujo de caja">
      {({ start, end }) => (
        <Loader start={start} end={end} onData={setData}>
          <p className="text-sm text-muted-foreground">
            El dinero que entra (ventas, depósitos) menos el que sale (gastos,
            sueldos, compras, retiros). Vender mucho no sirve si se va todo en
            costos: este número es el que de verdad te queda.
          </p>

          <div className="
            grid grid-cols-1 gap-3
            sm:grid-cols-3
          "
          >
            <StatTile label="Entradas" value={fmtMoney(data.income)} tone="good" />
            <StatTile label="Salidas" value={fmtMoney(data.expenses)} tone="danger" />
            <StatTile
              label="Flujo neto"
              value={fmtMoney(data.net)}
              tone={data.net >= 0 ? 'good' : 'danger'}
            />
          </div>

          <ChartCard
            title="Entradas vs salidas por día"
            description="Si la línea de salidas se acerca o supera a la de entradas, revisá tus gastos."
          >
            <TrendChart
              data={data.daily}
              xKey="day"
              series={[
                { key: 'income', name: 'Entradas', color: '#15803D' },
                { key: 'expenses', name: 'Salidas', color: '#C2410C' },
              ]}
            />
          </ChartCard>

          <ChartCard
            title="A dónde se va la plata"
            description="Composición de movimientos por tipo."
          >
            <DonutChart
              data={data.byType.map(t => ({
                label: TYPE_LABELS[t.type] ?? t.type,
                amount: t.amount,
              }))}
              nameKey="label"
              valueKey="amount"
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
  onData: (data: CashFlowReport) => void;
  children: React.ReactNode;
}) {
  const prev = useRef('');
  useEffect(() => {
    const key = `${start}|${end}`;
    if (key !== prev.current) {
      prev.current = key;
      getCashFlow(start, end).then(onData).catch(() => onData(EMPTY));
    }
  }, [start, end, onData]);
  return <div className="space-y-4">{children}</div>;
}
