'use client';

import type {
  DeliveryEvent,
  DeliveryKpis,
  DeliveryOrder,
  DeliveryOrderWithContact,
  DeliveryStatus,
} from './actions';
import type { CancelReasonKey } from './cancellation-reasons';
import { Bike, Camera, MessageCircle, Phone } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
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
  listDeliveriesForCourier,
  requestAddressClarification,
  transitionDelivery,
} from './actions';
import { CANCEL_REASONS } from './cancellation-reasons';
import { logDeliveryContact } from './contact-log-actions';
import { DeliveryChatDialog } from './DeliveryChatDialog';

// A payment method the courier can pick at delivery: its display name (forwarded
// to createSaleForOrg) plus its type, so the checkout knows which method is cash
// (the only one that can give change / vuelto in a mixed payment).
export type DeliverPaymentMethod = { name: string; type?: string };

// Extra payload threaded from a dialog into a transition (payment method +
// invoice intent for 'delivered'; reason for 'cancelled'). `payments` carries a
// mixed (split) breakdown; when present, `paymentType` is the summary 'Mixto'.
type TransitionExtra = {
  paymentType?: string;
  payments?: { method: string; amount: number }[];
  wantsInvoice?: boolean;
  cancelReason?: CancelReasonKey;
  cancelReasonText?: string;
  // P-photo: the courier-captured hand-off photo URL, set only on 'delivered'.
  deliveryPhotoUrl?: string;
};

// Cash-method name hints (client mirror of cash-helpers' CASH_PAYMENT_METHODS),
// used only as a fallback when a method carries no explicit type.
const CLIENT_CASH_HINTS = ['efectivo', 'cash'];

type DeliveryItem = { name: string; qty: number; price: number; productId?: string };
type Scope = DeliveryStatus | 'active' | 'all';

// Card-level order shape: the admin board's list (listDeliveries) carries
// contact flags (DeliveryOrderWithContact); the courier board's pool/mine
// (listDeliveriesForCourier) does not fetch them, so DeliveryCard/
// CourierSections accept them as optional and treat "missing" as "no contact
// logged yet" — never a per-card fetch either way.
type DeliveryCardOrder = DeliveryOrder & {
  contactedCall?: boolean;
  contactedWhatsapp?: boolean;
};

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

// Zeroed KPIs used only as the initial state for a courier viewer, who never
// fetches money KPIs (no admin data is requested for them at all).
const EMPTY_KPIS: DeliveryKpis = {
  active: 0,
  inTransit: 0,
  deliveredToday: 0,
  feesToday: '0',
};

// Display-only "orphan" flag: a pending order nobody has claimed yet, waiting
// past a sensible default threshold. No new setting for this slice — just a
// hardcoded minute count, purely cosmetic (never gates an action).
const ORPHAN_THRESHOLD_MIN = 10;

function orphanBadge(order: DeliveryOrder): string | null {
  if (order.status !== 'pending' || order.courierId) {
    return null;
  }
  const created
    = typeof order.createdAt === 'string' ? new Date(order.createdAt) : order.createdAt;
  if (!created) {
    return null;
  }
  const minutes = Math.floor((Date.now() - created.getTime()) / 60000);
  if (minutes < ORPHAN_THRESHOLD_MIN) {
    return null;
  }
  return `🔴 hace ${minutes} min`;
}

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

type DeliveryClientCommonProps = {
  // Org payment methods offered in the deliver dialog (P0-B).
  paymentMethods: DeliverPaymentMethod[];
  // Whether the org has e-invoicing configured — gates the invoice checkbox (P2-A).
  einvoiceEnabled: boolean;
  // The org's `delivery_require_photo` app_setting — gates the photo-evidence
  // block in the deliver dialog and disables its confirm button without one.
  requirePhoto: boolean;
  // This org id + the viewer's own panel-user (pos_users) id. Needed to poll
  // the courier board (listDeliveriesForCourier) and, for an admin in "Modo
  // repartidor", to know which claimed orders are THEIRS. Null when the
  // viewer has no linked employee row (e.g. an admin who never became one).
  orgId: string;
  viewerCourierId: string | null;
};

// Role-aware board (approved model): org:admin gets the CONTROL view (ALL
// orders + KPIs, as before) with a "Modo repartidor" toggle into the courier
// layout; a non-admin panel user holding the `delivery` grant only ever gets
// the COURIER view (their own POOL + MIS PEDIDOS). page.tsx resolves which
// role applies server-side — this component never re-derives it, only
// branches rendering on `viewerRole`.
type DeliveryClientProps = DeliveryClientCommonProps & (
  | { viewerRole: 'admin'; initial: DeliveryOrderWithContact[]; kpis: DeliveryKpis }
  | { viewerRole: 'courier'; pool: DeliveryOrder[]; mine: DeliveryOrder[] }
);

export function DeliveryClient(props: DeliveryClientProps) {
  const isAdmin = props.viewerRole === 'admin';

  // Admin control-view data (all-org orders + KPIs). Also the SOURCE for an
  // admin's own "Modo repartidor" pool/mine (derived below via useMemo) — no
  // separate query, since the admin already has every order in `rows`.
  const [rows, setRows] = useState<DeliveryOrderWithContact[]>(
    props.viewerRole === 'admin' ? props.initial : [],
  );
  const [kpis, setKpis] = useState<DeliveryKpis>(
    props.viewerRole === 'admin' ? props.kpis : EMPTY_KPIS,
  );
  const [scope, setScope] = useState<Scope>('active');

  // A real (non-admin) courier's own pool + mine, fetched server-side and
  // polled independently of the admin's `rows`.
  const [pool, setPool] = useState<DeliveryOrder[]>(
    props.viewerRole === 'courier' ? props.pool : [],
  );
  const [mine, setMine] = useState<DeliveryOrder[]>(
    props.viewerRole === 'courier' ? props.mine : [],
  );

  // "Modo repartidor" (admin only): flips the admin into the courier layout so
  // they can take/execute like a courier. Never a separate fetch — pool/mine
  // are just a filter over the SAME all-org `rows` the admin already has.
  const [repartidorMode, setRepartidorMode] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Effective layout: an admin who hasn't flipped "Modo repartidor" sees the
  // control view; everyone else (a real courier, or an admin who flipped it)
  // sees the courier layout.
  const showCourierLayout = !isAdmin || repartidorMode;

  const adminPool = useMemo(
    () => rows.filter(r => r.status === 'pending' && !r.courierId),
    [rows],
  );
  const adminMine = useMemo(() => {
    const myId = props.viewerCourierId;
    if (!myId) {
      return [];
    }
    return rows.filter(
      r => r.courierId === myId && (r.status === 'assigned' || r.status === 'in_transit'),
    );
  }, [rows, props.viewerCourierId]);

  const courierPool = isAdmin ? adminPool : pool;
  const courierMine = isAdmin ? adminMine : mine;

  const refetchAdmin = useCallback(async () => {
    const [data, freshKpis] = await Promise.all([
      listDeliveries({ status: scope }),
      getDeliveryKpis(),
    ]);
    setRows(data);
    setKpis(freshKpis);
  }, [scope]);

  const refetchCourier = useCallback(async () => {
    const courierId = props.viewerCourierId;
    if (!courierId) {
      return;
    }
    const { pool: freshPool, mine: freshMine } = await listDeliveriesForCourier(
      props.orgId,
      courierId,
    );
    setPool(freshPool);
    setMine(freshMine);
  }, [props.orgId, props.viewerCourierId]);

  // Admin polling: refetch on scope change + on an interval, so cancellations
  // drop off and new (agent-made) orders surface without a manual reload.
  // Also feeds "Modo repartidor" (adminPool/adminMine derive from `rows`).
  useEffect(() => {
    if (props.viewerRole !== 'admin') {
      return;
    }
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
  }, [props.viewerRole, scope]);

  // Courier polling: a real (non-admin) courier's own pool + mine.
  useEffect(() => {
    const courierId = props.viewerCourierId;
    if (props.viewerRole !== 'courier' || !courierId) {
      return;
    }
    let cancelled = false;
    const run = () => {
      listDeliveriesForCourier(props.orgId, courierId)
        .then(({ pool: freshPool, mine: freshMine }) => {
          if (!cancelled) {
            setPool(freshPool);
            setMine(freshMine);
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
  }, [props.viewerRole, props.orgId, props.viewerCourierId]);

  function toggleRepartidorMode() {
    setRepartidorMode((v) => {
      const next = !v;
      // Force the underlying admin fetch to 'active' so pool/mine derive from
      // the full pending+assigned+in_transit set, regardless of whichever
      // status chip the admin had selected in the control view.
      if (next) {
        setScope('active');
      }
      return next;
    });
  }

  function act(
    order: DeliveryOrder,
    to: DeliveryStatus,
    extra?: TransitionExtra,
  ) {
    setError(null);
    startTransition(async () => {
      try {
        await transitionDelivery(order.id, { status: to, ...extra });
        await (isAdmin ? refetchAdmin() : refetchCourier());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  return (
    <div className="space-y-6">
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={repartidorMode ? 'default' : 'outline'}
            size="sm"
            onClick={toggleRepartidorMode}
          >
            <Bike className="size-4" />
            {repartidorMode ? 'Salir de modo repartidor' : 'Modo repartidor'}
          </Button>
        </div>
      )}

      {error && (
        <div className="
          rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3
          text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      {showCourierLayout
        ? (
            <CourierSections
              pool={courierPool}
              mine={courierMine}
              pending={pending}
              paymentMethods={props.paymentMethods}
              einvoiceEnabled={props.einvoiceEnabled}
              requirePhoto={props.requirePhoto}
              onAct={act}
            />
          )
        : (
            <>
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
                      flex flex-col items-center justify-center rounded-xl
                      border border-dashed border-border bg-card px-6 py-16
                      text-center
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
                          paymentMethods={props.paymentMethods}
                          einvoiceEnabled={props.einvoiceEnabled}
                          requirePhoto={props.requirePhoto}
                          onAct={act}
                        />
                      ))}
                    </div>
                  )}
            </>
          )}

      <Toaster />
    </div>
  );
}

// The courier layout (a real courier viewer, or an admin in "Modo
// repartidor"): a POOL of unclaimed pending orders anyone can self-claim, and
// MIS PEDIDOS — this viewer's own claimed, non-terminal orders. No money
// KPIs, no status chips, no other couriers' orders. Reuses the same
// DeliveryCard/dialogs as the admin view — pool cards just get a restricted
// action set (variant="pool": only "Tomar", no WhatsApp/historial/cancelar).
function CourierSections({
  pool,
  mine,
  pending,
  paymentMethods,
  einvoiceEnabled,
  requirePhoto,
  onAct,
}: {
  pool: DeliveryCardOrder[];
  mine: DeliveryCardOrder[];
  pending: boolean;
  paymentMethods: DeliverPaymentMethod[];
  einvoiceEnabled: boolean;
  requirePhoto: boolean;
  onAct: (
    order: DeliveryOrder,
    to: DeliveryStatus,
    extra?: TransitionExtra,
  ) => void;
}) {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {`📥 Sin tomar (${pool.length})`}
        </h2>
        {pool.length === 0
          ? <EmptySection text="No hay pedidos esperando." />
          : (
              <div className="
                grid gap-3
                lg:grid-cols-2
              "
              >
                {pool.map(order => (
                  <DeliveryCard
                    key={order.id}
                    order={order}
                    pending={pending}
                    variant="pool"
                    paymentMethods={paymentMethods}
                    einvoiceEnabled={einvoiceEnabled}
                    requirePhoto={requirePhoto}
                    onAct={onAct}
                  />
                ))}
              </div>
            )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {`🛵 Mis pedidos (${mine.length})`}
        </h2>
        {mine.length === 0
          ? <EmptySection text="Todavía no tomaste ningún pedido." />
          : (
              <div className="
                grid gap-3
                lg:grid-cols-2
              "
              >
                {mine.map(order => (
                  <DeliveryCard
                    key={order.id}
                    order={order}
                    pending={pending}
                    paymentMethods={paymentMethods}
                    einvoiceEnabled={einvoiceEnabled}
                    requirePhoto={requirePhoto}
                    onAct={onAct}
                  />
                ))}
              </div>
            )}
      </section>
    </div>
  );
}

function EmptySection({ text }: { text: string }) {
  return (
    <div className="
      rounded-xl border border-dashed border-border bg-card px-6 py-10
      text-center text-sm text-muted-foreground
    "
    >
      {text}
    </div>
  );
}

function DeliveryCard({
  order,
  pending,
  // 'full' (default): every control — WhatsApp, aclaración, historial,
  // cancelar, next-action. 'pool': a POOL card (unclaimed pending order) —
  // ONLY the next-action button ("Tomar"), nothing else. Reuses this same
  // card shell rather than a separate component.
  variant = 'full',
  paymentMethods,
  einvoiceEnabled,
  requirePhoto,
  onAct,
}: {
  order: DeliveryCardOrder;
  pending: boolean;
  variant?: 'full' | 'pool';
  paymentMethods: DeliverPaymentMethod[];
  einvoiceEnabled: boolean;
  requirePhoto: boolean;
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
  const [chatOpen, setChatOpen] = useState(false);
  const meta = STATUS_META[order.status];
  const next = NEXT_ACTION[order.status];
  const items = Array.isArray(order.items) ? (order.items as DeliveryItem[]) : [];
  const isPool = variant === 'pool';
  const canCancel = !isPool && order.status !== 'delivered' && order.status !== 'cancelled';
  const phoneDigits = order.customerPhone?.replace(/\D/g, '') ?? '';
  const orphan = orphanBadge(order);

  // Courier tool: ask the customer for details to arrive, over the org's own
  // WhatsApp. Optimistic disable while sending; the toast reports the outcome.
  async function askClarification() {
    // Fire-and-forget contact log — never blocks or fails the actual request.
    logDeliveryContact(order.id, 'whatsapp').catch(() => {});
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
          {orphan && (
            <span className="ml-2 text-xs font-medium text-destructive">
              {orphan}
            </span>
          )}
          {!isPool && order.contactedCall && (
            <span className="ml-2 text-xs" title="Contactado por llamada">
              📞
            </span>
          )}
          {!isPool && order.contactedWhatsapp && (
            <span className="ml-2 text-xs" title="Contactado por WhatsApp">
              💬
            </span>
          )}
          {!isPool
            && order.status === 'cancelled'
            && !order.contactedCall
            && !order.contactedWhatsapp && (
            <span
              className="
                ml-2 inline-flex items-center rounded-full bg-destructive/10
                px-2 py-0.5 text-xs font-medium text-destructive
              "
              title="Sin contacto"
            >
              🚩 Sin contacto
            </span>
          )}
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
        {!isPool && phoneDigits && (
          <a
            href={`tel:${phoneDigits}`}
            onClick={() => {
              logDeliveryContact(order.id, 'call').catch(() => {});
            }}
            className="
              inline-flex h-8 items-center gap-1.5 rounded-md border
              border-border px-3 text-sm font-medium text-muted-foreground
              hover:text-foreground
            "
          >
            <Phone className="size-4" />
            Llamar
          </a>
        )}
        {!isPool && phoneDigits && (
          <button
            type="button"
            onClick={() => {
              logDeliveryContact(order.id, 'whatsapp').catch(() => {});
              setChatOpen(true);
            }}
            className="
              inline-flex h-8 items-center gap-1.5 rounded-md border
              border-border px-3 text-sm font-medium text-muted-foreground
              hover:text-foreground
            "
          >
            <MessageCircle className="size-4" />
            Chat
          </button>
        )}
        {!isPool && phoneDigits && (
          <a
            href={`https://wa.me/${phoneDigits}`}
            target="_blank"
            rel="noreferrer"
            onClick={() => {
              logDeliveryContact(order.id, 'whatsapp').catch(() => {});
            }}
            className="
              inline-flex h-8 items-center rounded-md border border-border px-3
              text-sm font-medium text-muted-foreground
              hover:text-foreground
            "
          >
            WhatsApp
          </a>
        )}
        {!isPool && canCancel && phoneDigits && (
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
        {!isPool && (
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
        )}
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
              ? (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => setDeliverOpen(true)}
                  >
                    {next.label}
                  </Button>
                )
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
          orderId={order.id}
          // Split the GOODS subtotal only: the sale is priced goods-only and the
          // delivery fee is settled separately (settleDeliveryFee). order.total
          // = subtotal + fee, so splitting it would double-count the fee.
          goodsTotal={Number(order.subtotal) || 0}
          deliveryFee={Number(order.deliveryFee) || 0}
          paymentMethods={paymentMethods}
          einvoiceEnabled={einvoiceEnabled}
          requirePhoto={requirePhoto}
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

      {chatOpen && (
        <DeliveryChatDialog
          orderId={order.id}
          customerName={order.customerName}
          onClose={() => setChatOpen(false)}
        />
      )}
    </div>
  );
}

// Deliver dialog (P0-B + P2-A): a POS-style checkout for a contraentrega. The
// courier taps the single method the customer paid with, or switches on
// "Combinar métodos" to split the goods total across several methods (pago
// mixto) — one row per method + amount, with a live "Falta / Vuelto" readout.
// Only cash can exceed its share (change); a purely-digital split must land on
// the total exactly. When the org has e-invoicing on, a "quiere factura"
// checkbox rides along. Defaults to the first method (Efectivo is always seeded).
function DeliverDialog({
  onClose,
  pending,
  orderId,
  goodsTotal,
  deliveryFee,
  paymentMethods,
  einvoiceEnabled,
  requirePhoto,
  onConfirm,
}: {
  onClose: () => void;
  pending: boolean;
  // The delivery order id — the photo-evidence upload is stored under
  // deliveries/<orgId>/<orderId>/ on the server.
  orderId: string;
  // The GOODS subtotal — what the sale is priced at and what the split must sum
  // to. NOT order.total (that includes the delivery fee, settled separately).
  goodsTotal: number;
  deliveryFee: number;
  paymentMethods: DeliverPaymentMethod[];
  einvoiceEnabled: boolean;
  // The org's `delivery_require_photo` app_setting — when true, a photo is
  // mandatory before the confirm button unlocks (server re-checks it too).
  requirePhoto: boolean;
  onConfirm: (extra: TransitionExtra) => void;
}) {
  // Fall back to Efectivo if the org somehow exposes no active method.
  const methods = useMemo(
    () => (paymentMethods.length > 0
      ? paymentMethods
      : [{ name: 'Efectivo', type: 'cash' }]),
    [paymentMethods],
  );

  // Cash is the only method that can be handed in above its share (→ vuelto).
  // Prefer the explicit type from the org catalog; fall back to a name hint.
  const isCash = useCallback(
    (name: string) =>
      methods.find(m => m.name === name)?.type === 'cash'
      || CLIENT_CASH_HINTS.some(h => name.toLowerCase().includes(h)),
    [methods],
  );

  const [combine, setCombine] = useState(false);
  // Single-method path: the one tapped method (defaults to the first).
  const [single, setSingle] = useState<string>(methods[0]!.name);
  // Mixed path: one draft row per method the customer used, seeded with the full
  // total on the first method.
  const [drafts, setDrafts] = useState<{ method: string; amount: string }[]>([
    { method: methods[0]!.name, amount: String(goodsTotal) },
  ]);
  const [wantsInvoice, setWantsInvoice] = useState(false);

  // P-photo: the hand-off evidence photo. Uploaded eagerly on file select (not
  // deferred to confirm) so the courier sees the thumbnail before committing.
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  async function handlePhotoFile(file: File | undefined) {
    if (!file) {
      return;
    }
    setUploadingPhoto(true);
    setPhotoError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('deliveryOrderId', orderId);
      const res = await fetch('/api/upload/delivery-photo', {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Error al subir (${res.status})`);
      }
      const data = (await res.json()) as { url: string };
      setPhotoUrl(data.url);
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : 'No se pudo subir la foto');
    } finally {
      setUploadingPhoto(false);
      if (photoInputRef.current) {
        photoInputRef.current.value = '';
      }
    }
  }

  const amountOf = (a: string) => Number.parseFloat(a) || 0;

  // Mirrors the POS checkout math: cash is "handed in" (may exceed its share →
  // vuelto), every other method applies its full amount straight to the bill.
  const totals = useMemo(() => {
    let appliedToBill = 0;
    let cashHandedIn = 0;
    for (const d of drafts) {
      const v = amountOf(d.amount);
      if (isCash(d.method)) {
        cashHandedIn += v;
      } else {
        appliedToBill += v;
      }
    }
    const cashApplied = Math.min(
      cashHandedIn,
      Math.max(0, goodsTotal - appliedToBill),
    );
    const change = Math.max(0, cashHandedIn - cashApplied);
    const remaining = Math.max(0, goodsTotal - appliedToBill - cashApplied);
    // Only CASH may exceed its share (→ vuelto). Digital methods over the bill
    // would book a sale_payment above the sale total, so they invalidate.
    const overpaidDigital = appliedToBill > goodsTotal;
    return { change, remaining, overpaidDigital };
  }, [drafts, goodsTotal, isCash]);

  const mixedValid
    = totals.remaining === 0
      && !totals.overpaidDigital
      && drafts.some(d => amountOf(d.amount) > 0);

  function addDraft() {
    const nextMethod
      = methods.find(m => !drafts.some(d => d.method === m.name))?.name
        ?? methods[0]!.name;
    setDrafts(ds => [
      ...ds,
      {
        method: nextMethod,
        amount: totals.remaining > 0 ? String(totals.remaining) : '',
      },
    ]);
  }
  function updateDraft(
    i: number,
    patch: Partial<{ method: string; amount: string }>,
  ) {
    setDrafts(ds => ds.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }
  function removeDraft(i: number) {
    setDrafts(ds => ds.filter((_, idx) => idx !== i));
  }

  function confirm() {
    const photoExtra = photoUrl ? { deliveryPhotoUrl: photoUrl } : {};
    if (!combine) {
      onConfirm({ paymentType: single, wantsInvoice, ...photoExtra });
      return;
    }
    // Build the sale_payments breakdown: cash contributes only what covers the
    // bill (the rest is vuelto), other methods their full amount. Matches the POS.
    let cashBudget = Math.max(
      0,
      goodsTotal
      - drafts
        .filter(d => !isCash(d.method))
        .reduce((s, d) => s + amountOf(d.amount), 0),
    );
    const payments: { method: string; amount: number }[] = [];
    for (const d of drafts) {
      const v = amountOf(d.amount);
      if (v <= 0) {
        continue;
      }
      if (isCash(d.method)) {
        const cover = Math.min(v, cashBudget);
        cashBudget -= cover;
        if (cover > 0) {
          payments.push({ method: d.method, amount: cover });
        }
      } else {
        payments.push({ method: d.method, amount: v });
      }
    }
    onConfirm({ paymentType: 'Mixto', payments, wantsInvoice, ...photoExtra });
  }

  const canConfirm
    = !pending
      && !uploadingPhoto
      && (combine ? mixedValid : true)
      && (!requirePhoto || !!photoUrl);

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Confirmar entrega</DialogTitle>
          <DialogDescription>
            Elegí cómo pagó el cliente. La venta entra a tu caja con ese método.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">
              {deliveryFee > 0 ? 'Venta (mercancía)' : 'Total a cobrar'}
            </span>
            <span className="font-display text-xl font-medium tabular-nums">
              {money(goodsTotal)}
            </span>
          </div>
          {deliveryFee > 0 && (
            <p className="-mt-2 text-xs text-muted-foreground">
              + Domicilio
              {' '}
              <span className="tabular-nums">{money(deliveryFee)}</span>
              {' '}
              se cobra aparte (no entra en el reparto).
            </p>
          )}

          {!combine
            ? (
                // Single method: a tap-once grid of the org's methods.
                <div className="grid grid-cols-2 gap-2">
                  {methods.map(m => (
                    <button
                      key={m.name}
                      type="button"
                      disabled={pending}
                      onClick={() => setSingle(m.name)}
                      className={cn(
                        `
                          flex h-11 items-center justify-center rounded-md
                          border px-3 text-sm font-medium
                          disabled:opacity-60
                        `,
                        single === m.name
                          ? 'border-primary bg-primary/10 text-foreground'
                          : `
                            border-border text-muted-foreground
                            hover:text-foreground
                          `,
                      )}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )
            : (
                // Mixed: a row per method (own amount) plus a live Falta/Vuelto line.
                <div className="space-y-2">
                  {drafts.map((d, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <div key={i} className="flex items-center gap-2">
                      <select
                        value={d.method}
                        onChange={e => updateDraft(i, { method: e.target.value })}
                        disabled={pending}
                        className="
                          h-9 flex-1 rounded-md border border-border
                          bg-background px-2 text-sm
                        "
                      >
                        {methods.map(m => (
                          <option key={m.name} value={m.name}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={d.amount}
                        onChange={e => updateDraft(i, { amount: e.target.value })}
                        disabled={pending}
                        placeholder="0"
                        className="
                          h-9 w-28 rounded-md border border-border bg-background
                          px-2 text-right text-sm tabular-nums
                        "
                      />
                      {drafts.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeDraft(i)}
                          disabled={pending}
                          aria-label="Quitar método"
                          className="
                            flex size-9 shrink-0 items-center justify-center
                            rounded-md text-muted-foreground
                            hover:text-destructive
                          "
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}

                  {drafts.length < methods.length && (
                    <button
                      type="button"
                      onClick={addDraft}
                      disabled={pending}
                      className="
                        text-sm font-medium text-primary
                        hover:underline
                      "
                    >
                      + Agregar método
                    </button>
                  )}

                  <div className="
                    flex justify-between border-t border-border pt-2 text-sm
                  "
                  >
                    {totals.overpaidDigital
                      ? (
                          <span className="text-destructive">
                            Los métodos digitales superan el total
                          </span>
                        )
                      : totals.remaining > 0
                        ? (
                            <span className="text-destructive">
                              Falta
                              {' '}
                              <span className="tabular-nums">
                                {money(totals.remaining)}
                              </span>
                            </span>
                          )
                        : (
                            <span className="text-muted-foreground">Cubierto</span>
                          )}
                    {totals.change > 0 && (
                      <span className="text-muted-foreground">
                        Vuelto
                        {' '}
                        <span className="tabular-nums">{money(totals.change)}</span>
                      </span>
                    )}
                  </div>
                </div>
              )}

          <button
            type="button"
            onClick={() => setCombine(c => !c)}
            disabled={pending}
            className={cn(
              'text-sm font-medium',
              combine
                ? 'text-primary'
                : `
                  text-muted-foreground
                  hover:text-foreground
                `,
            )}
          >
            {combine ? '✓ Pago mixto' : '+ Combinar métodos'}
          </button>

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

          {requirePhoto && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-sm font-medium">Evidencia de entrega</div>
              <p className="text-xs text-muted-foreground">
                Este negocio exige una foto del pedido entregado para confirmar.
              </p>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={e => handlePhotoFile(e.target.files?.[0])}
              />
              {photoUrl
                ? (
                    <div className="flex items-center gap-3">
                      {/* eslint-disable-next-line next/no-img-element */}
                      <img
                        src={photoUrl}
                        alt="Evidencia de entrega"
                        className="
                          size-16 rounded-md border border-border object-cover
                        "
                      />
                      <div className="flex flex-col items-start gap-1">
                        <button
                          type="button"
                          disabled={pending || uploadingPhoto}
                          onClick={() => photoInputRef.current?.click()}
                          className="
                            text-sm font-medium text-primary
                            hover:underline
                            disabled:opacity-60
                          "
                        >
                          Cambiar foto
                        </button>
                        <button
                          type="button"
                          disabled={pending || uploadingPhoto}
                          onClick={() => setPhotoUrl(null)}
                          className="
                            text-sm font-medium text-destructive
                            hover:underline
                            disabled:opacity-60
                          "
                        >
                          Quitar
                        </button>
                      </div>
                    </div>
                  )
                : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending || uploadingPhoto}
                      onClick={() => photoInputRef.current?.click()}
                    >
                      <Camera className="size-4" />
                      {uploadingPhoto ? 'Subiendo…' : 'Tomar o subir foto'}
                    </Button>
                  )}
              {photoError && (
                <p className="text-xs text-destructive">{photoError}</p>
              )}
            </div>
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
            disabled={!canConfirm}
            onClick={confirm}
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
            {ev.note && !isContactNote(ev.note) && (
              <span className="text-muted-foreground">{` — ${ev.note}`}</span>
            )}
            <div className="text-muted-foreground">{timeAgo(ev.createdAt)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

// Contact-log markers (contact-log-actions.ts#logDeliveryContact) are internal
// bookkeeping, not a human note — describeEvent() renders a clean label for
// them instead, so the raw 'contact:call'/'contact:whatsapp' string never
// leaks into the Historial timeline.
function isContactNote(note: string): boolean {
  return note === 'contact:call' || note === 'contact:whatsapp';
}

function describeEvent(ev: DeliveryEvent): string {
  if (ev.type === 'created') {
    return 'Pedido creado';
  }
  if (ev.type === 'customer_notified') {
    return 'Cliente notificado';
  }
  if (ev.type === 'note' && ev.note === 'contact:call') {
    return 'Llamada al cliente';
  }
  if (ev.type === 'note' && ev.note === 'contact:whatsapp') {
    return 'Contacto por WhatsApp';
  }
  if (ev.type === 'note') {
    return 'Nota';
  }
  if (ev.type === 'status_change' && ev.toStatus) {
    return STATUS_META[ev.toStatus].label;
  }
  return 'Actualización';
}
