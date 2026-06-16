'use client';

import type { TodayCollections } from '@/actions/cash';
import { cn } from '@/utils/Helpers';
import { money } from './cash-ui';

type FraudAlert = {
  kind: string;
  severity: 'high' | 'mid' | 'low';
  count: number;
  message: string;
};

// How money came in today, bucketed by the business's REAL payment methods
// (ventas + abonos). Plus the fraud alerts. Part of the single Caja supervision
// page — closures and the movement ledger live inside each caja's detail.

function isCashMethod(name: string): boolean {
  return /efectivo|cash/i.test(name);
}

function CollectionCard(props: { name: string; amount: number }) {
  const zero = props.amount === 0;
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
      <div className="text-sm font-semibold text-muted-foreground">
        {props.name}
      </div>
      <div className="text-xs text-muted-foreground/80">
        {isCashMethod(props.name) ? 'plata en mano' : 'transferencias'}
      </div>
      <div
        className={cn(
          'mt-3 font-display text-3xl font-semibold tabular-nums',
          zero ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {money(props.amount)}
      </div>
    </div>
  );
}

export function CashClient(props: {
  collections: TodayCollections;
  alerts: FraudAlert[];
}) {
  const { collections } = props;

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

      <section className="space-y-3">
        <div>
          <h2 className="font-display text-lg font-semibold">
            ¿Cuánta plata entró hoy?
          </h2>
          <p className="text-sm text-muted-foreground">
            Suma de todo lo que cobraron hoy en todas las cajas.
          </p>
        </div>

        {collections.methods.length === 0
          ? (
              <div className="
                rounded-lg border border-dashed border-border p-4 text-sm
                text-muted-foreground
              "
              >
                No hay métodos de pago configurados.
              </div>
            )
          : (
              <div className="
                grid grid-cols-1 gap-4
                sm:grid-cols-2
                lg:grid-cols-3
              "
              >
                {collections.methods.map(m => (
                  <CollectionCard key={m.name} name={m.name} amount={m.amount} />
                ))}
                <div className="
                  rounded-xl border border-primary/20 bg-brand-soft p-5
                  shadow-xs
                "
                >
                  <div className="text-sm font-semibold text-primary">
                    Total del día
                  </div>
                  <div className="text-xs text-primary/70">
                    efectivo + transferencias
                  </div>
                  <div className="
                    mt-3 font-display text-3xl font-semibold text-brand-ink
                    tabular-nums
                  "
                  >
                    {money(collections.total)}
                  </div>
                </div>
              </div>
            )}
      </section>
    </div>
  );
}
