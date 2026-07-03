import type { SaleDetail } from '@/actions/sales';
import { setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSaleDetail, getSaleTimeline } from '@/actions/sales';
import { Badge } from '@/components/ui/badge';
import { SaleTimeline } from '@/features/sales/SaleTimeline';
import { formatSaleNumber } from '@/libs/sale-number';
import { cn } from '@/utils/Helpers';

const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'full',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

const shortDateFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

function money(value: string | number): string {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? moneyFmt.format(n) : String(value);
}

// Same quantity-based rule as the listing: returned units vs sold units.
function statusBadge(detail: SaleDetail): { label: string; cls: string } {
  const sold = detail.items.reduce((acc, it) => acc + it.qty, 0);
  const returned = detail.items.reduce((acc, it) => acc + it.returnedQty, 0);
  if (returned > 0 && returned >= sold) {
    return {
      label: 'Devuelta totalmente',
      cls: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
    };
  }
  if (returned > 0) {
    return {
      label: 'Parcialmente devuelta',
      cls: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    };
  }
  return {
    label: 'Completada',
    cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  };
}

const RETURN_REASON_LABELS: Record<string, string> = {
  customer_request: 'Cambio de opinión del cliente',
  damaged: 'Producto dañado',
};

// Friendly Spanish labels for the delivery status machine, shared by the
// order's current status and its status_change events.
const DELIVERY_STATUS_LABELS: Record<string, string> = {
  pending: 'Pedido tomado',
  assigned: 'Tomado por el repartidor',
  in_transit: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
};

// Renders a single delivery event as a human label — mirrors describeEvent()
// in features/delivery/DeliveryClient.tsx.
function deliveryEventLabel(ev: { type: string; toStatus: string | null }): string {
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
    return DELIVERY_STATUS_LABELS[ev.toStatus] ?? 'Actualización';
  }
  return 'Actualización';
}

const DISPOSITION_LABELS: Record<string, string> = {
  restock: 'Volvió al inventario',
  damaged: 'Merma (dañado)',
  discard: 'Descartado',
};

function initials(name: string | null): string {
  if (!name) {
    return '—';
  }
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '—';
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium">{children}</span>
    </div>
  );
}

export default async function SaleDetailPage(props: {
  params: Promise<{ locale: string; saleId: string }>;
}) {
  const { locale, saleId } = await props.params;
  setRequestLocale(locale);

  const [detail, timeline] = await Promise.all([
    getSaleDetail(saleId),
    getSaleTimeline(saleId),
  ]);
  if (!detail) {
    notFound();
  }

  const status = statusBadge(detail);
  const itemsSubtotal = detail.items.reduce(
    (acc, it) => acc + Number.parseFloat(it.subtotal),
    0,
  );
  const totalRefunded = detail.returns.reduce(
    (acc, r) => acc + Number.parseFloat(r.totalRefunded),
    0,
  );

  return (
    <div className="space-y-6">
      {/* Header: back link, sale number, status, date */}
      <div>
        <Link
          href="/dashboard/sales"
          className="
            text-sm text-muted-foreground
            hover:text-primary hover:underline
          "
        >
          ← Ventas
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-medium tracking-tight">
            Venta
            {' '}
            {formatSaleNumber(detail.saleNumber)}
          </h1>
          <Badge variant="outline" className={status.cls}>
            {status.label}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {dateFmt.format(detail.createdAt)}
        </p>
      </div>

      <div className="
        grid grid-cols-1 gap-4
        lg:grid-cols-3
      "
      >
        {/* Left column: items + returns trail */}
        <div className="
          space-y-4
          lg:col-span-2
        "
        >
          <div className="rounded-lg border bg-background shadow-xs">
            <div className="border-b px-4 py-3 text-sm font-semibold">
              Productos
            </div>
            <table className="w-full text-sm">
              <thead className="
                text-left text-xs text-muted-foreground uppercase
              "
              >
                <tr className="border-b">
                  <th className="px-4 py-2 font-medium">Producto</th>
                  <th className="px-4 py-2 text-right font-medium">Cantidad</th>
                  <th className="px-4 py-2 text-right font-medium">Precio</th>
                  <th className="px-4 py-2 text-right font-medium">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {detail.items.map(item => (
                  <tr
                    key={item.id}
                    className="
                      border-b
                      last:border-b-0
                    "
                  >
                    <td className="px-4 py-2.5">
                      <span className="block">{item.productName}</span>
                      {item.returnedQty > 0 && (
                        <span className="
                          text-[11px] font-medium text-amber-600
                          dark:text-amber-400
                        "
                        >
                          {item.returnedQty}
                          {' '}
                          devuelta(s)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {item.qty}
                      {item.unitType !== 'unit' && (
                        <span className="text-xs text-muted-foreground">
                          {' '}
                          {item.unitType}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {money(item.price)}
                    </td>
                    <td className="
                      px-4 py-2.5 text-right font-medium tabular-nums
                    "
                    >
                      {money(item.subtotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30">
                  <td
                    colSpan={3}
                    className="px-4 py-2.5 text-right text-muted-foreground"
                  >
                    Subtotal
                  </td>
                  <td className="
                    px-4 py-2.5 text-right font-medium tabular-nums
                  "
                  >
                    {money(itemsSubtotal)}
                  </td>
                </tr>
                <tr className="bg-muted/30">
                  <td
                    colSpan={3}
                    className="px-4 py-2.5 text-right font-semibold"
                  >
                    Total
                  </td>
                  <td className="
                    px-4 py-2.5 text-right font-semibold tabular-nums
                  "
                  >
                    {money(detail.total)}
                  </td>
                </tr>
                {totalRefunded > 0 && (
                  <tr className="bg-muted/30">
                    <td
                      colSpan={3}
                      className="px-4 py-2.5 text-right text-red-600"
                    >
                      Reembolsado
                    </td>
                    <td className="
                      px-4 py-2.5 text-right font-medium text-red-600
                      tabular-nums
                    "
                    >
                      −
                      {money(totalRefunded)}
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>

          {detail.returns.length > 0 && (
            <div className="rounded-lg border bg-background shadow-xs">
              <div className="border-b px-4 py-3 text-sm font-semibold">
                Devoluciones
              </div>
              <div className="divide-y">
                {detail.returns.map(ret => (
                  <div key={ret.id} className="space-y-2 px-4 py-3">
                    <div className="
                      flex flex-wrap items-center justify-between gap-2 text-sm
                    "
                    >
                      <span className="font-medium">
                        {RETURN_REASON_LABELS[ret.reason] ?? ret.reason}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {shortDateFmt.format(ret.createdAt)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {ret.partial ? 'Devolución parcial' : 'Devolución total'}
                      {' · reembolso en '}
                      {ret.refundMethod}
                      {ret.cashierName ? ` · procesada por ${ret.cashierName}` : ''}
                    </div>
                    <ul className="space-y-1">
                      {ret.items.map((ri, idx) => (

                        <li
                          key={`${ret.id}-${idx}`}
                          className="
                            flex items-center justify-between gap-2 text-xs
                          "
                        >
                          <span className="min-w-0 truncate">
                            {ri.qty}
                            {' × '}
                            {ri.productName}
                            <span className="text-muted-foreground">
                              {' — '}
                              {DISPOSITION_LABELS[ri.disposition] ?? ri.disposition}
                            </span>
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {money(ri.refundAmount)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="
                      flex items-center justify-between border-t pt-2 text-sm
                    "
                    >
                      <span className="text-muted-foreground">Total reembolsado</span>
                      <span className="font-medium tabular-nums">
                        {money(ret.totalRefunded)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column: who, where, how */}
        <div className="space-y-4">
          <div className="
            space-y-3 rounded-lg border bg-background p-4 shadow-xs
          "
          >
            <div className="text-sm font-semibold">Vendida por</div>
            <div className="flex items-center gap-3">
              {detail.cashierImageUrl
                ? (
                    // eslint-disable-next-line next/no-img-element
                    <img
                      src={detail.cashierImageUrl}
                      alt=""
                      className="size-9 shrink-0 rounded-full object-cover"
                    />
                  )
                : (
                    <span className="
                      flex size-9 shrink-0 items-center justify-center
                      rounded-full bg-muted text-xs font-semibold
                      text-muted-foreground
                    "
                    >
                      {initials(detail.cashierName ?? detail.deviceName)}
                    </span>
                  )}
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {detail.cashierName ?? detail.deviceName ?? '—'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {detail.origin === 'pos' ? 'Cajero POS' : 'Panel web'}
                </div>
              </div>
            </div>
          </div>

          <div className="
            space-y-3 rounded-lg border bg-background p-4 shadow-xs
          "
          >
            <div className="text-sm font-semibold">Origen</div>
            <InfoRow label="Canal">
              {detail.delivery
                ? 'Domicilio'
                : detail.origin === 'pos'
                  ? 'Punto de venta (POS)'
                  : 'Panel web'}
            </InfoRow>
            {detail.deviceName && (
              <InfoRow label="Caja">{detail.deviceName}</InfoRow>
            )}
            <InfoRow label="Fecha">
              {shortDateFmt.format(detail.createdAt)}
            </InfoRow>
          </div>

          <div className="
            space-y-3 rounded-lg border bg-background p-4 shadow-xs
          "
          >
            <div className="text-sm font-semibold">Pago</div>
            <InfoRow label="Método">{detail.paymentType}</InfoRow>
            {detail.payments.map(p => (
              <div key={p.id} className="space-y-1 border-t pt-2">
                <InfoRow label={p.method}>{money(p.amount)}</InfoRow>
                {Number.parseFloat(p.changeGiven) > 0 && (
                  <InfoRow label="Cambio entregado">
                    {money(p.changeGiven)}
                  </InfoRow>
                )}
                {p.reference && (
                  <InfoRow label="Referencia">{p.reference}</InfoRow>
                )}
              </div>
            ))}
          </div>

          <SaleTimeline events={timeline} />

          {detail.delivery && (
            <div className="
              space-y-3 rounded-lg border bg-background p-4 shadow-xs
            "
            >
              <div className="text-sm font-semibold">Proceso del domicilio</div>
              <InfoRow label="Estado actual">
                {DELIVERY_STATUS_LABELS[detail.delivery.status] ?? detail.delivery.status}
              </InfoRow>
              {detail.delivery.address && (
                <InfoRow label="Dirección">{detail.delivery.address}</InfoRow>
              )}
              {detail.delivery.courierName && (
                <InfoRow label="Repartidor">{detail.delivery.courierName}</InfoRow>
              )}
              {detail.delivery.events.length > 0 && (
                <ol className="relative pt-1">
                  {detail.delivery.events.map((e, i) => (
                    <li
                      key={`${e.type}-${e.createdAt.toISOString()}-${i}`}
                      className="
                        relative flex gap-3 pb-4
                        last:pb-0
                      "
                    >
                      {i < detail.delivery!.events.length - 1 && (
                        <span
                          className="
                            absolute top-3 bottom-0 left-[5px] w-px bg-border
                          "
                          aria-hidden
                        />
                      )}
                      <span
                        className="
                          relative z-10 mt-1 size-3 shrink-0 rounded-full
                          border-2 border-emerald-500 bg-emerald-500
                        "
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-medium">
                          {deliveryEventLabel(e)}
                        </span>
                        {e.note && (
                          <div className="text-xs text-muted-foreground">
                            {e.note}
                          </div>
                        )}
                        <div className="
                          mt-0.5 text-[11px] text-muted-foreground tabular-nums
                        "
                        >
                          {shortDateFmt.format(e.createdAt)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          <div className="
            space-y-3 rounded-lg border bg-background p-4 shadow-xs
          "
          >
            <div className="text-sm font-semibold">Facturación electrónica</div>
            <InfoRow label="Estado">
              {detail.einvoiceStatus === 'emitted'
                ? 'Emitida'
                : detail.einvoiceStatus === 'failed'
                  ? 'Falló'
                  : 'Pendiente'}
            </InfoRow>
            {detail.einvoiceNumber && (
              <InfoRow label="Número">{detail.einvoiceNumber}</InfoRow>
            )}
          </div>

          {detail.notes && (
            <div className={cn(
              'space-y-2 rounded-lg border bg-background p-4 shadow-xs',
            )}
            >
              <div className="text-sm font-semibold">Notas</div>
              <p className="text-sm text-muted-foreground">{detail.notes}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
