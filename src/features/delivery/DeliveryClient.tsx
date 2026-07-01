'use client';

import type {
  DeliveryEvent,
  DeliveryKpis,
  DeliveryOrder,
  DeliveryStatus,
} from './actions';
import type { CancelReasonKey } from './cancellation-reasons';
import type { ActiveCourierShift, OpenCaja } from './shifts';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Toaster } from '@/components/ui/toast';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/utils/Helpers';
import {
  getDeliveryEvents,
  getDeliveryKpis,
  listDeliveries,
  requestAddressClarification,
  transitionDelivery,
} from './actions';
import { CANCEL_REASONS } from './cancellation-reasons';
import {
  endCourierShift,
  getActiveCourierShift,
  listOpenCajas,
  startCourierShift,
} from './shifts';

// A payment method the courier can pick at delivery — just its display name,
// which is what createDeliverySale forwards to createSaleForOrg.
export type DeliverPaymentMethod = { name: string };

// Extra payload threaded from a dialog into a transition (payment method +
// invoice intent for 'delivered'; reason for 'cancelled').
type TransitionExtra = {
  paymentType?: string;
  wantsInvoice?: boolean;
  cancelReason?: CancelReasonKey;
  cancelReasonText?: string;
};

// Sentinel select value for the admin/dashboard caja (posTokenId === null).
const ADMIN_CAJA_VALUE = '__admin__';

function cajaValue(posTokenId: string | null): string {
  return posTokenId ?? ADMIN_CAJA_VALUE;
}

function valueToPosToken(value: string): string | null {
  return value === ADMIN_CAJA_VALUE ? null : value;
}

type DeliveryItem = { name: string; qty: number; price: number; productId?: string };
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
  initialShift: ActiveCourierShift | null;
  openCajas: OpenCaja[];
  // Org payment methods offered in the deliver dialog (P0-B).
  paymentMethods: DeliverPaymentMethod[];
  // Whether the org has e-invoicing configured — gates the invoice checkbox (P2-A).
  einvoiceEnabled: boolean;
}) {
  const [rows, setRows] = useState<DeliveryOrder[]>(props.initial);
  const [kpis, setKpis] = useState<DeliveryKpis>(props.kpis);
  const [scope, setScope] = useState<Scope>('active');
  const [error, setError] = useState<string | null>(null);
  const [shift, setShift] = useState<ActiveCourierShift | null>(props.initialShift);
  const [cajas, setCajas] = useState<OpenCaja[]>(props.openCajas);
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

  // Re-read the courier's shift + the open-caja choices after they start/end a
  // shift, so the board and the "Marcar entregado" gating update immediately.
  const refreshShift = useCallback(async () => {
    const [freshShift, freshCajas] = await Promise.all([
      getActiveCourierShift(),
      listOpenCajas(),
    ]);
    setShift(freshShift);
    setCajas(freshCajas);
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

  function act(
    order: DeliveryOrder,
    to: DeliveryStatus,
    extra?: TransitionExtra,
  ) {
    setError(null);
    startTransition(async () => {
      try {
        await transitionDelivery(order.id, { status: to, ...extra });
        await refetch();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  return (
    <div className="space-y-6">
      <ShiftBar shift={shift} cajas={cajas} onChanged={refreshShift} />

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
                Los pedidos que tome el asistente aparecerán aquí para el
                domiciliario.
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
                  hasShift={shift !== null}
                  paymentMethods={props.paymentMethods}
                  einvoiceEnabled={props.einvoiceEnabled}
                  onAct={act}
                />
              ))}
            </div>
          )}

      <Toaster />
    </div>
  );
}

// Shift control: the courier declares an EXISTING open caja before delivering,
// so every delivered order becomes a cash sale in it. Blocks nothing on its own
// — the "Marcar entregado" gating lives on each card via hasShift — but this is
// where the courier starts/ends their day and switches caja.
function ShiftBar({
  shift,
  cajas,
  onChanged,
}: {
  shift: ActiveCourierShift | null;
  cajas: OpenCaja[];
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // The effective choice: the courier's pick when it's still an open caja, else
  // the first open caja. Derived during render so a changing open-caja list
  // never needs an effect to reconcile the selection.
  const effectiveSelected
    = selected && cajas.some(c => cajaValue(c.posTokenId) === selected)
      ? selected
      : (cajas[0] ? cajaValue(cajas[0].posTokenId) : '');

  async function start() {
    if (!effectiveSelected) {
      return;
    }
    setBusy(true);
    try {
      await startCourierShift(valueToPosToken(effectiveSelected));
      toast.success('Jornada iniciada. Ya podés marcar entregas.');
      await onChanged();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'No se pudo iniciar la jornada.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    setBusy(true);
    try {
      await endCourierShift();
      toast.success('Jornada terminada.');
      await onChanged();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'No se pudo terminar la jornada.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (shift) {
    return (
      <div className="
        flex flex-wrap items-center gap-3 rounded-xl border border-border
        bg-card p-4 shadow-xs
      "
      >
        <span className="inline-flex size-2 shrink-0 rounded-full bg-success" />
        <span className="text-sm font-medium">Jornada activa</span>
        <span className="text-sm text-muted-foreground">
          Caja:
          {' '}
          {shift.cajaLabel}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={busy}
          onClick={end}
        >
          {busy ? 'Terminando…' : 'Terminar jornada'}
        </Button>
      </div>
    );
  }

  return (
    <div className="
      flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card
      p-4 shadow-xs
    "
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">Iniciá tu jornada</div>
        <p className="text-xs text-muted-foreground">
          Elegí la caja donde entrarán las ventas de tus entregas.
        </p>
      </div>
      {cajas.length === 0
        ? (
            <span className="ml-auto text-sm text-muted-foreground">
              No hay cajas abiertas. Pedí que abran una para empezar.
            </span>
          )
        : (
            <div className="ml-auto flex items-center gap-2">
              <select
                value={effectiveSelected}
                onChange={e => setSelected(e.target.value)}
                disabled={busy}
                className="
                  h-9 rounded-md border border-border bg-background px-2 text-sm
                "
              >
                {cajas.map(c => (
                  <option
                    key={cajaValue(c.posTokenId)}
                    value={cajaValue(c.posTokenId)}
                  >
                    {c.label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={busy || !effectiveSelected}
                onClick={start}
              >
                {busy ? 'Iniciando…' : 'Iniciar jornada'}
              </Button>
            </div>
          )}
    </div>
  );
}

function DeliveryCard({
  order,
  pending,
  hasShift,
  paymentMethods,
  einvoiceEnabled,
  onAct,
}: {
  order: DeliveryOrder;
  pending: boolean;
  hasShift: boolean;
  paymentMethods: DeliverPaymentMethod[];
  einvoiceEnabled: boolean;
  onAct: (
    order: DeliveryOrder,
    to: DeliveryStatus,
    extra?: TransitionExtra,
  ) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const meta = STATUS_META[order.status];
  const next = NEXT_ACTION[order.status];
  const items = Array.isArray(order.items) ? (order.items as DeliveryItem[]) : [];
  const canCancel = order.status !== 'delivered' && order.status !== 'cancelled';
  const phoneDigits = order.customerPhone?.replace(/\D/g, '') ?? '';

  // Courier tool: ask the customer for details to arrive, over the org's own
  // WhatsApp. Optimistic disable while sending; the toast reports the outcome.
  async function askClarification() {
    setClarifying(true);
    try {
      const res = await requestAddressClarification(order.id);
      if (res.sent) {
        toast.success('Le pedimos al cliente más detalles de la dirección.');
      } else if (res.skipped) {
        toast.error(
          res.reason === 'no_connected_channel'
            ? 'Conectá un WhatsApp del negocio para enviar mensajes.'
            : res.reason === 'missing_recipient'
              ? 'Este pedido no tiene teléfono del cliente.'
              : 'WhatsApp no está configurado.',
        );
      } else {
        toast.error('No se pudo enviar el mensaje. Intentá de nuevo.');
      }
    } catch {
      toast.error('No se pudo enviar el mensaje. Intentá de nuevo.');
    } finally {
      setClarifying(false);
    }
  }

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
        {canCancel && phoneDigits && (
          <button
            type="button"
            onClick={askClarification}
            disabled={clarifying}
            className="
              inline-flex h-8 items-center rounded-md border border-border px-3
              text-sm font-medium text-muted-foreground
              hover:text-foreground
              disabled:opacity-60
            "
          >
            {clarifying ? 'Enviando…' : 'Pedir aclaración de dirección'}
          </button>
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
              onClick={() => setCancelOpen(true)}
            >
              Cancelar
            </Button>
          )}
          {next && (
            next.to === 'delivered'
              ? (!hasShift
                  ? (
                      <div className="flex flex-col items-end gap-1">
                        <Button size="sm" disabled>
                          {next.label}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          Iniciá tu jornada para entregar.
                        </span>
                      </div>
                    )
                  : (
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => setDeliverOpen(true)}
                      >
                        {next.label}
                      </Button>
                    ))
              : (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => onAct(order, next.to)}
                  >
                    {next.label}
                  </Button>
                )
          )}
        </div>
      </div>

      {showHistory && <HistoryTimeline orderId={order.id} />}

      {/* Mounted only while open so each open starts from fresh local state — no
          reset effect needed, and no stale selection leaks between deliveries. */}
      {deliverOpen && (
        <DeliverDialog
          onClose={() => setDeliverOpen(false)}
          pending={pending}
          paymentMethods={paymentMethods}
          einvoiceEnabled={einvoiceEnabled}
          onConfirm={(extra) => {
            setDeliverOpen(false);
            onAct(order, 'delivered', extra);
          }}
        />
      )}

      {cancelOpen && (
        <CancelDialog
          onClose={() => setCancelOpen(false)}
          pending={pending}
          onConfirm={(extra) => {
            setCancelOpen(false);
            onAct(order, 'cancelled', extra);
          }}
        />
      )}
    </div>
  );
}

// Deliver dialog (P0-B + P2-A): pick the payment method the customer paid with,
// and — only when the org has e-invoicing enabled — optionally request an
// electronic invoice. Defaults to the first method (Efectivo is always seeded).
function DeliverDialog({
  onClose,
  pending,
  paymentMethods,
  einvoiceEnabled,
  onConfirm,
}: {
  onClose: () => void;
  pending: boolean;
  paymentMethods: DeliverPaymentMethod[];
  einvoiceEnabled: boolean;
  onConfirm: (extra: TransitionExtra) => void;
}) {
  // Fall back to Efectivo if the org somehow exposes no active method.
  const methods = paymentMethods.length > 0
    ? paymentMethods
    : [{ name: 'Efectivo' }];
  const [method, setMethod] = useState<string>(methods[0]!.name);
  const [wantsInvoice, setWantsInvoice] = useState(false);

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Confirmar entrega</DialogTitle>
          <DialogDescription>
            Elegí cómo pagó el cliente. La venta entra a tu caja con ese método.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="deliver-method">
            Método de pago
          </label>
          <select
            id="deliver-method"
            value={method}
            onChange={e => setMethod(e.target.value)}
            disabled={pending}
            className="
              h-9 w-full rounded-md border border-border bg-background px-2
              text-sm
            "
          >
            {methods.map(m => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>

          {einvoiceEnabled && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={wantsInvoice}
                onChange={e => setWantsInvoice(e.target.checked)}
                disabled={pending}
                className="size-4 rounded-sm border-border"
              />
              El cliente quiere factura electrónica
            </label>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              onConfirm({ paymentType: method, wantsInvoice })}
          >
            Marcar entregado
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Cancel dialog (P1): the reason is REQUIRED; 'otro' reveals a free-text field
// whose content is stored on the event note (but not sent to the customer).
function CancelDialog({
  onClose,
  pending,
  onConfirm,
}: {
  onClose: () => void;
  pending: boolean;
  onConfirm: (extra: TransitionExtra) => void;
}) {
  const [reason, setReason] = useState<CancelReasonKey | ''>('');
  const [text, setText] = useState('');

  const canConfirm = reason !== '' && (reason !== 'otro' || text.trim() !== '');

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Cancelar pedido</DialogTitle>
          <DialogDescription>
            Elegí el motivo. Le avisamos al cliente con un mensaje acorde.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="cancel-reason">
            Motivo
          </label>
          <select
            id="cancel-reason"
            value={reason}
            onChange={e => setReason(e.target.value as CancelReasonKey | '')}
            disabled={pending}
            className="
              h-9 w-full rounded-md border border-border bg-background px-2
              text-sm
            "
          >
            <option value="" disabled>
              Elegí un motivo…
            </option>
            {CANCEL_REASONS.map(r => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>

          {reason === 'otro' && (
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              disabled={pending}
              maxLength={500}
              rows={3}
              placeholder="Contanos qué pasó…"
              className="
                w-full rounded-md border border-border bg-background px-2 py-1.5
                text-sm
              "
            />
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={onClose}
          >
            Volver
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending || !canConfirm}
            onClick={() =>
              reason !== ''
              && onConfirm({
                cancelReason: reason,
                cancelReasonText: reason === 'otro' ? text.trim() : undefined,
              })}
          >
            Cancelar pedido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
