'use client';

import type {
  DeliveryEvent,
  DeliveryKpis,
  DeliveryOrder,
  DeliveryStatus,
} from './actions';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import {
  getDeliveryEvents,
  getDeliveryKpis,
  listDeliveries,
  transitionDelivery,
} from './actions';
import { NewDeliveryModal } from './NewDeliveryModal';

type DeliveryItem = { name: string; qty: number; price: number };
type Scope = DeliveryStatus | 'active' | 'all';

// How often the board refetches so cancellations drop off and new (agent-made)
// orders appear without a manual reload. Polling, not realtime — deliberately
// simple; can be upgraded to push later.
const POLL_MS = 15000;

const cop = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

function money(value: string | number | null | undefined): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value ?? 0;
  return cop.format(Number.isFinite(n as number) ? (n as number) : 0);
}

function timeAgo(d: Date | string | null): string {
  if (!d) {
    return '—';
  }
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('es-CO', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STATUS_META: Record<
  DeliveryStatus,
  { label: string; cls: string }
> = {
  pending: { label: 'Pendiente', cls: 'bg-muted text-muted-foreground' },
  assigned: { label: 'Asignado', cls: 'bg-brand-soft text-brand' },
  in_transit: {
    label: 'En camino',
    cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  delivered: { label: 'Entregado', cls: 'bg-success/15 text-success' },
  cancelled: { label: 'Cancelado', cls: 'bg-destructive/10 text-destructive' },
};

// The single forward action offered per status (the courier's "do the next
// thing" button). Terminal states have none.
const NEXT_ACTION: Partial<
  Record<DeliveryStatus, { label: string; to: DeliveryStatus }>
> = {
  pending: { label: 'Tomar', to: 'assigned' },
  assigned: { label: 'En camino', to: 'in_transit' },
  in_transit: { label: 'Marcar entregado', to: 'delivered' },
};

const FILTERS: { key: Scope; label: string }[] = [
  { key: 'active', label: 'Activos' },
  { key: 'pending', label: 'Pendientes' },
  { key: 'assigned', label: 'Asignados' },
  { key: 'in_transit', label: 'En camino' },
  { key: 'delivered', label: 'Entregados' },
  { key: 'cancelled', label: 'Cancelados' },
  { key: 'all', label: 'Todos' },
];

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="
        mt-1.5 font-display text-xl font-medium tracking-tight tabular-nums
      "
      >
        {value}
      </div>
    </div>
  );
}

export function DeliveryClient(props: {
  initial: DeliveryOrder[];
  kpis: DeliveryKpis;
}) {
  const [rows, setRows] = useState<DeliveryOrder[]>(props.initial);
  const [kpis, setKpis] = useState<DeliveryKpis>(props.kpis);
  const [scope, setScope] = useState<Scope>('active');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const scopeRef = useRef<Scope>(scope);
  scopeRef.current = scope;

  const refetch = useCallback(async () => {
    const [data, freshKpis] = await Promise.all([
      listDeliveries({ status: scopeRef.current }),
      getDeliveryKpis(),
    ]);
    setRows(data);
    setKpis(freshKpis);
  }, []);

  // Refetch on scope change + poll on an interval so cancellations drop off and
  // new (agent-made) orders surface without a manual reload.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      Promise.all([
        listDeliveries({ status: scope }),
        getDeliveryKpis(),
      ])
        .then(([data, freshKpis]) => {
          if (!cancelled) {
            setRows(data);
            setKpis(freshKpis);
          }
        })
        .catch(() => {});
    };
    run();
    const id = setInterval(run, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [scope]);

  function act(order: DeliveryOrder, to: DeliveryStatus) {
    setError(null);
    startTransition(async () => {
      try {
        await transitionDelivery(order.id, { status: to });
        await refetch();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  function onCreated(order: DeliveryOrder) {
    setRows(prev => [order, ...prev]);
    setOpen(false);
    setScope('active');
  }

  return (
    <div className="space-y-6">
      <div className="
        grid grid-cols-2 gap-3
        lg:grid-cols-4
      "
      >
        <StatCard label="Activos" value={String(kpis.active)} />
        <StatCard label="En camino" value={String(kpis.inTransit)} />
        <StatCard label="Entregados hoy" value={String(kpis.deliveredToday)} />
        <StatCard label="Domicilios cobrados hoy" value={money(kpis.feesToday)} />
      </div>

      {error && (
        <div className="
          rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3
          text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map(f => (
          <button
            key={f.key}
            type="button"
            onClick={() => setScope(f.key)}
            className={cn(
              `
                rounded-full border px-3 py-1 text-sm font-medium
                transition-colors
              `,
              scope === f.key
                ? 'border-brand bg-brand-soft text-brand'
                : `
                  border-border text-muted-foreground
                  hover:text-foreground
                `,
            )}
          >
            {f.label}
          </button>
        ))}
        <Button className="ml-auto" onClick={() => setOpen(true)}>
          Nuevo domicilio
        </Button>
      </div>

      {rows.length === 0
        ? (
            <div className="
              flex flex-col items-center justify-center rounded-xl border
              border-dashed border-border bg-card px-6 py-16 text-center
            "
            >
              <div className="text-5xl">🛵</div>
              <div className="mt-4 text-lg font-semibold">
                No hay domicilios en esta vista
              </div>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Los pedidos que tome el asistente o que registres a mano
                aparecerán aquí para el domiciliario.
              </p>
            </div>
          )
        : (
            <div className="
              grid gap-3
              lg:grid-cols-2
            "
            >
              {rows.map(order => (
                <DeliveryCard
                  key={order.id}
                  order={order}
                  pending={pending}
                  onAct={act}
                />
              ))}
            </div>
          )}

      <NewDeliveryModal open={open} onOpenChange={setOpen} onSaved={onCreated} />
    </div>
  );
}

function DeliveryCard({
  order,
  pending,
  onAct,
}: {
  order: DeliveryOrder;
  pending: boolean;
  onAct: (order: DeliveryOrder, to: DeliveryStatus) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const meta = STATUS_META[order.status];
  const next = NEXT_ACTION[order.status];
  const items = Array.isArray(order.items) ? (order.items as DeliveryItem[]) : [];
  const canCancel = order.status !== 'delivered' && order.status !== 'cancelled';
  const phoneDigits = order.customerPhone?.replace(/\D/g, '') ?? '';

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span
            className={cn(
              `
                inline-flex items-center rounded-full px-2 py-0.5 text-xs
                font-medium
              `,
              meta.cls,
            )}
          >
            {meta.label}
          </span>
          <p className="mt-2 font-medium">{order.customerName ?? 'Sin nombre'}</p>
          <p className="text-sm text-muted-foreground">{order.address}</p>
          {order.addressNotes && (
            <p className="text-xs text-muted-foreground">{order.addressNotes}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-lg font-medium tabular-nums">
            {money(order.total)}
          </div>
          {Number(order.deliveryFee) > 0 && (
            <div className="text-xs text-muted-foreground">
              Domicilio
              {' '}
              {money(order.deliveryFee)}
            </div>
          )}
        </div>
      </div>

      {items.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-sm">
          {items.map((it, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i} className="flex justify-between gap-2">
              <span className="truncate text-muted-foreground">
                {it.qty}
                {' × '}
                {it.name}
              </span>
              <span className="tabular-nums">{money(it.qty * it.price)}</span>
            </li>
          ))}
        </ul>
      )}

      {order.notes && (
        <p className="
          mt-3 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs
          text-muted-foreground
        "
        >
          {order.notes}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {phoneDigits && (
          <a
            href={`https://wa.me/${phoneDigits}`}
            target="_blank"
            rel="noreferrer"
            className="
              inline-flex h-8 items-center rounded-md border border-border px-3
              text-sm font-medium text-muted-foreground
              hover:text-foreground
            "
          >
            WhatsApp
          </a>
        )}
        <button
          type="button"
          onClick={() => setShowHistory(s => !s)}
          className="
            inline-flex h-8 items-center rounded-md px-2 text-sm font-medium
            text-muted-foreground
            hover:text-foreground
          "
        >
          {showHistory ? 'Ocultar historial' : 'Historial'}
        </button>
        <div className="ml-auto flex items-center gap-2">
          {canCancel && (
            <Button
              variant="ghost"
              size="sm"
              className="
                text-destructive
                hover:text-destructive
              "
              disabled={pending}
              onClick={() => onAct(order, 'cancelled')}
            >
              Cancelar
            </Button>
          )}
          {next && (
            <Button size="sm" disabled={pending} onClick={() => onAct(order, next.to)}>
              {next.label}
            </Button>
          )}
        </div>
      </div>

      {showHistory && <HistoryTimeline orderId={order.id} />}
    </div>
  );
}

function HistoryTimeline({ orderId }: { orderId: string }) {
  const [events, setEvents] = useState<DeliveryEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDeliveryEvents(orderId)
      .then((data) => {
        if (!cancelled) {
          setEvents(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEvents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (events === null) {
    return <p className="mt-3 text-xs text-muted-foreground">Cargando historial…</p>;
  }
  if (events.length === 0) {
    return <p className="mt-3 text-xs text-muted-foreground">Sin eventos.</p>;
  }

  return (
    <ol className="mt-3 space-y-2 border-t border-border pt-3">
      {events.map(ev => (
        <li key={ev.id} className="flex items-start gap-2 text-xs">
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-brand" />
          <div className="min-w-0">
            <span className="font-medium">{describeEvent(ev)}</span>
            {ev.note && <span className="text-muted-foreground">{` — ${ev.note}`}</span>}
            <div className="text-muted-foreground">{timeAgo(ev.createdAt)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function describeEvent(ev: DeliveryEvent): string {
  if (ev.type === 'created') {
    return 'Pedido creado';
  }
  if (ev.type === 'customer_notified') {
    return 'Cliente notificado';
  }
  if (ev.type === 'note') {
    return 'Nota';
  }
  if (ev.type === 'status_change' && ev.toStatus) {
    return STATUS_META[ev.toStatus].label;
  }
  return 'Actualización';
}
