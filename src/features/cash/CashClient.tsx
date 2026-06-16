'use client';

import type { GetCurrentCashResult } from '@/actions/cash';
import { cn } from '@/utils/Helpers';
import { money } from './cash-ui';

type FraudAlert = {
  kind: string;
  severity: 'high' | 'mid' | 'low';
  count: number;
  message: string;
};

function Card(props: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card shadow-xs',
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

function StatCard(props: { label: string; value: string; tone?: 'in' | 'out' }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium text-muted-foreground">
        {props.label}
      </div>
      <div
        className={cn(
          'mt-1.5 font-display text-xl font-medium tracking-tight tabular-nums',
          props.tone === 'in' && 'text-success',
        )}
      >
        {props.value}
      </div>
    </Card>
  );
}

// Secondary section of the Caja module (the cajas list is the hero). Shows the
// fraud alerts and how money came in today by method. Closures and the movement
// ledger are NOT here — they live inside each caja's detail, filtered to it.
export function CashClient(props: {
  current: GetCurrentCashResult;
  alerts: FraudAlert[];
}) {
  const { collections } = props.current;

  return (
    <div className="space-y-6">
      {props.alerts.length > 0 && (
        <div className="space-y-2">
          {props.alerts.map(a => (
            <div
              key={a.kind}
              className={cn(
                'flex items-start gap-2 rounded-lg border px-4 py-3 text-sm',
                a.severity === 'high'
                  ? 'border-destructive/30 bg-destructive/10 text-destructive'
                  : 'border-warn/30 bg-warn/10 text-warn',
              )}
            >
              <span className="mt-0.5 size-2 shrink-0 rounded-full bg-current" />
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Cobros por método — cómo entró la plata hoy (ventas + abonos). */}
      <div className="space-y-2">
        <div className="text-sm font-medium">
          Cobros por método
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            · ventas + abonos
          </span>
        </div>
        <div className="
          grid grid-cols-2 gap-3
          sm:grid-cols-3
          lg:grid-cols-6
        "
        >
          <StatCard label="Efectivo" value={money(collections.efectivo)} tone="in" />
          <StatCard label="Transferencia" value={money(collections.transferencia)} />
          <StatCard label="Nequi" value={money(collections.nequi)} />
          <StatCard label="Daviplata" value={money(collections.daviplata)} />
          <StatCard label="Otros" value={money(collections.otros)} />
          <StatCard label="Total general" value={money(collections.total)} tone="in" />
        </div>
      </div>
    </div>
  );
}
