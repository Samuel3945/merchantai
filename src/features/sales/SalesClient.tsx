'use client';

import type {
  ListSalesResult,
  ReturnableItem,
  SaleListRow,
  SaleReturnDetail,
} from '@/actions/sales';
import type { ReturnDisposition, ReturnReason } from '@/libs/sale-returns';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { listPaymentMethods } from '@/actions/payment-methods';
import { getSaleForReturn, listSales, processReturn } from '@/actions/sales';
import { DateRangePicker } from '@/components/DateRangePicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { formatSaleNumber } from '@/libs/sale-number';
import { buildPresetOptions, todayBogota } from '@/utils/DateRange';
import { cn } from '@/utils/Helpers';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const labelCls = 'text-xs font-medium text-muted-foreground';

const paymentOptions = [
  { value: 'all', label: 'Todos los pagos' },
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'transferencia', label: 'Transferencia / Nequi / Daviplata' },
];

// Two reasons, each with its destination baked in: a change of mind returns the
// goods to sellable stock; a defective product leaves inventory as damaged and
// does NOT come back. `effect` is shown so the cashier sees what will happen.
const RETURN_REASONS: {
  value: ReturnReason;
  label: string;
  effect: string;
}[] = [
  {
    value: 'customer_request',
    label: 'Cambio de opinión del cliente',
    effect: 'La mercancía vuelve al inventario disponible.',
  },
  {
    value: 'damaged',
    label: 'Producto dañado',
    effect:
      'Se entrega un reemplazo: no se devuelve dinero. Sale del stock como merma, valuada al costo.',
  },
];

const moneyFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

function formatMoney(value: string | number) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) {
    return String(value);
  }
  return moneyFmt.format(n);
}

function remainingOf(item: ReturnableItem) {
  return Math.max(0, item.qty - item.returnedQty);
}

// Up to two initials for the avatar fallback when a cashier has no photo.
function initials(name: string | null): string {
  if (!name) {
    return '—';
  }
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '—';
}

// Cashier identity for the table: real photo when Clerk provides one, otherwise
// a tidy initials chip. Always a human name, never a raw user id.
function CashierCell({
  name,
  imageUrl,
}: {
  name: string | null;
  imageUrl: string | null;
}) {
  return (
    <div className="flex items-center gap-2">
      {imageUrl
        ? (
            <img
              src={imageUrl}
              alt=""
              className="size-6 shrink-0 rounded-full object-cover"
            />
          )
        : (
            <span className="
              flex size-6 shrink-0 items-center justify-center rounded-full
              bg-muted text-[10px] font-semibold text-muted-foreground
            "
            >
              {initials(name)}
            </span>
          )}
      <span className="truncate">{name ?? '—'}</span>
    </div>
  );
}

function lineRefund(item: ReturnableItem, qty: number) {
  const sub = Number.parseFloat(item.subtotal);
  if (!Number.isFinite(sub) || item.qty <= 0) {
    return 0;
  }
  return Math.round(((sub / item.qty) * qty) * 100) / 100;
}

// Return status, derived from the sale's own state — no schema change needed.
// `returned` means the whole sale came back; `hasReturn` on a non-returned sale
// means some lines are still outstanding (partial); otherwise it is a clean sale.
function returnStatus(row: SaleListRow): { label: string; cls: string } {
  if (row.fullyReturned) {
    return {
      label: 'Devuelta totalmente',
      cls: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
    };
  }
  if (row.hasReturn) {
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

export function SalesClient({
  initial,
  pageSize,
}: {
  initial: ListSalesResult;
  pageSize: number;
}) {
  const [rows, setRows] = useState<SaleListRow[]>(initial.items);
  const [total, setTotal] = useState<number>(initial.total);
  const [page, setPage] = useState(0);

  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [payment, setPayment] = useState('all');
  const [search, setSearch] = useState('');
  const [cashierId, setCashierId] = useState('');

  const [pending, startTransition] = useTransition();
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRunRef = useRef(true);

  // ── Return modal state ────────────────────────────────────────────────────
  const [returnSale, setReturnSale] = useState<SaleReturnDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<ReturnReason>('customer_request');
  const [refundMethod, setRefundMethod] = useState('Efectivo');
  const [methods, setMethods] = useState<string[]>(['Efectivo']);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitSuccess, setSubmitSuccess] = useState('');

  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(total / pageSize)),
    [total, pageSize],
  );

  // Sales omits "Últimos 90 días" — the dashboard keeps the longer window.
  const presetOptions = useMemo(
    () => buildPresetOptions(['today', 'yesterday', '7d', '30d', 'mtd', 'lastMonth']),
    [],
  );

  async function fetchSales() {
    const data = await listSales({
      limit: pageSize,
      offset: page * pageSize,
      start: start || null,
      end: end || null,
      payment,
      search: search || null,
      cashierId: cashierId || null,
    });
    setRows(data.items);
    setTotal(data.total);
  }

  useEffect(() => {
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false;
      return;
    }
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      startTransition(fetchSales);
    }, 250);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
    // eslint-disable-next-line react/exhaustive-deps
  }, [pageSize, page, start, end, payment, search, cashierId]);

  function resetToFirstPage() {
    setPage(0);
  }

  function applyRange(next: { start: string; end: string; preset: string | null }) {
    setStart(next.start);
    setEnd(next.end);
    setActivePreset(next.preset);
    setPage(0);
  }

  function clearRange() {
    setStart('');
    setEnd('');
    setActivePreset(null);
    setPage(0);
  }

  function clearFilters() {
    setStart('');
    setEnd('');
    setActivePreset(null);
    setPayment('all');
    setSearch('');
    setCashierId('');
    setPage(0);
  }

  async function openReturn(saleId: string) {
    setReturnSale(null);
    setSubmitError('');
    setSubmitSuccess('');
    setReason('customer_request');
    setDetailLoading(true);
    try {
      const [detail, pms] = await Promise.all([
        getSaleForReturn(saleId),
        listPaymentMethods({ activeOnly: true }).catch(() => []),
      ]);

      const opts = [
        'Efectivo',
        ...pms
          .filter(m => m.type !== 'cash' && m.type !== 'credit')
          .map(m => m.name),
      ];
      setMethods([...new Set(opts)]);
      setRefundMethod('Efectivo');

      const initSelected = new Set<string>();
      const initQtys: Record<string, number> = {};
      for (const item of detail.items) {
        const remaining = remainingOf(item);
        if (remaining > 0) {
          initSelected.add(item.id);
          initQtys[item.id] = remaining;
        }
      }
      setSelected(initSelected);
      setQtys(initQtys);
      setReturnSale(detail);
    } catch (e) {
      setSubmitError(
        e instanceof Error ? e.message : 'No se pudo cargar la venta',
      );
      // Surface the error in a minimal shell so the user sees what happened.
      setReturnSale({
        id: saleId,
        saleNumber: null,
        total: '0',
        status: 'error',
        items: [],
      });
    } finally {
      setDetailLoading(false);
    }
  }

  function closeReturn() {
    setReturnSale(null);
    setSubmitError('');
  }

  async function confirmReturn() {
    if (!returnSale) {
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      // Destination is baked into the reason: a change of mind restocks; a
      // defective product is written off as damaged.
      const disposition: ReturnDisposition
        = reason === 'damaged' ? 'damaged' : 'restock';
      const chosen = returnSale.items.filter(it => selected.has(it.id));
      const items = chosen.map((it) => {
        const remaining = remainingOf(it);
        const qty = Math.min(qtys[it.id] ?? remaining, remaining);
        return {
          saleItemId: it.id,
          qty,
          refundAmount: reason === 'damaged' ? 0 : lineRefund(it, qty),
          disposition,
        };
      });

      // Partial when, after this return, any line still has units outstanding.
      const partial = !returnSale.items.every((it) => {
        const nowReturning = selected.has(it.id)
          ? (qtys[it.id] ?? remainingOf(it))
          : 0;
        return it.returnedQty + nowReturning >= it.qty;
      });

      await processReturn(returnSale.id, {
        reason,
        refundMethod,
        notes: null,
        partial,
        items,
      });

      setSubmitSuccess(
        partial ? 'Devolución parcial registrada' : 'Devolución registrada',
      );
      setReturnSale(null);
      await fetchSales();
      setTimeout(setSubmitSuccess, 4000, '');
    } catch (e) {
      setSubmitError(
        e instanceof Error ? e.message : 'No se pudo procesar la devolución',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const refundIsCash = ['efectivo', 'cash'].includes(refundMethod.toLowerCase());
  const selectedCount = selected.size;
  const reasonMeta = RETURN_REASONS.find(r => r.value === reason);
  const isDamaged = reason === 'damaged';

  const chosenItems = returnSale
    ? returnSale.items.filter(it => selected.has(it.id))
    : [];
  // A damaged exchange returns no cash, so there is nothing to refund.
  const totalRefund = isDamaged
    ? 0
    : chosenItems.reduce((acc, it) => {
        const remaining = remainingOf(it);
        const qty = Math.min(qtys[it.id] ?? remaining, remaining);
        return acc + lineRefund(it, qty);
      }, 0);

  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="space-y-4">
      {submitSuccess && (
        <div className="
          rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-2
          text-sm text-emerald-600
          dark:text-emerald-400
        "
        >
          {submitSuccess}
        </div>
      )}

      <div className="
        grid grid-cols-1 gap-3
        sm:grid-cols-2
        lg:grid-cols-4
      "
      >
        <div>
          <label className={labelCls}>Periodo</label>
          <div className="mt-1">
            <DateRangePicker
              start={start}
              end={end}
              compare={false}
              showCompare={false}
              activePreset={activePreset}
              presets={presetOptions}
              maxDate={todayBogota()}
              onApply={applyRange}
              onClear={clearRange}
              triggerClassName="w-full"
            />
          </div>
        </div>
        <div>
          <label className={labelCls}>Pago</label>
          <Select
            value={payment}
            onValueChange={(v) => {
              setPayment(v);
              resetToFirstPage();
            }}
            options={paymentOptions.map(opt => ({
              value: opt.value,
              label: opt.label,
            }))}
          />
        </div>
        <div>
          <label className={labelCls}>ID de cajero</label>
          <input
            type="text"
            value={cashierId}
            onChange={(e) => {
              setCashierId(e.target.value);
              resetToFirstPage();
            }}
            placeholder="user_..."
            className={cn(inputCls, 'font-mono text-xs')}
          />
        </div>
        <div>
          <label className={labelCls}>Buscar</label>
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetToFirstPage();
            }}
            placeholder="N.º de venta o nombre de producto"
            className={inputCls}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={clearFilters}>
          Limpiar filtros
        </Button>
        <div className="ml-auto text-sm text-muted-foreground">
          {pending
            ? 'Cargando…'
            : (
                <>
                  {from}
                  –
                  {to}
                  {' '}
                  de
                  {' '}
                  {total}
                </>
              )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Fecha</th>
              <th className="px-3 py-2">N.º venta</th>
              <th className="px-3 py-2">Pago</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Cajero</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right">Devolución</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0
              ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      {pending ? 'Cargando…' : 'No se encontraron ventas'}
                    </td>
                  </tr>
                )
              : (
                  rows.map((s) => {
                    const status = returnStatus(s);
                    const fullyReturned = s.fullyReturned;
                    return (
                      <tr key={s.id} className="border-t">
                        <td className="px-3 py-2 whitespace-nowrap">
                          {dateFmt.format(new Date(s.createdAt))}
                        </td>
                        <td className="px-3 py-2 font-medium tabular-nums">
                          {formatSaleNumber(s.saleNumber)}
                        </td>
                        <td className="px-3 py-2">{s.paymentType}</td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className={status.cls}>
                            {status.label}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          <CashierCell
                            name={s.cashierName}
                            imageUrl={s.cashierImageUrl}
                          />
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {formatMoney(s.total)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={detailLoading || fullyReturned}
                            onClick={() => openReturn(s.id)}
                          >
                            {fullyReturned
                              ? 'Devuelta'
                              : s.hasReturn
                                ? 'Devolver más'
                                : 'Devolver'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Página
          {' '}
          {page + 1}
          {' '}
          de
          {' '}
          {pageCount}
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={page === 0 || pending}
            onClick={() => setPage(p => Math.max(0, p - 1))}
          >
            Anterior
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= pageCount - 1 || pending}
            onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
          >
            Siguiente
          </Button>
        </div>
      </div>

      {/* ── Return modal (single screen) ── */}
      {returnSale && (
        <div className="
          fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4
        "
        >
          <div className="
            max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-lg
            border bg-background p-6 shadow-xl
          "
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-semibold">Procesar devolución</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Venta
                  {' '}
                  {formatSaleNumber(returnSale.saleNumber)}
                  {' '}
                  ·
                  {' '}
                  {formatMoney(returnSale.total)}
                </p>
              </div>
              <button
                type="button"
                onClick={closeReturn}
                className="
                  text-muted-foreground
                  hover:text-foreground
                "
                aria-label="Cerrar"
              >
                ✕
              </button>
            </div>

            {returnSale.items.length === 0
              ? (
                  <div className="
                    rounded-md border border-destructive/40 bg-destructive/10
                    px-3 py-2 text-sm text-destructive
                  "
                  >
                    {submitError || 'Esta venta no tiene items devolvibles.'}
                  </div>
                )
              : (
                  <>
                    {/* Products & quantities */}
                    <div className="space-y-2">
                      <p className={labelCls}>Productos a devolver</p>
                      {returnSale.items.map((item) => {
                        const remaining = remainingOf(item);
                        const fullyReturned = remaining <= 0;
                        const checked = selected.has(item.id) && !fullyReturned;
                        const qty = qtys[item.id] ?? remaining;
                        return (
                          <div
                            key={item.id}
                            className={cn(
                              `
                                flex items-center gap-3 rounded-md border p-2.5
                                transition-colors
                              `,
                              fullyReturned
                                ? 'opacity-50'
                                : checked
                                  ? 'border-primary/40 bg-primary/5'
                                  : 'opacity-70',
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={fullyReturned}
                              onChange={(e) => {
                                setSelected((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) {
                                    next.add(item.id);
                                  } else {
                                    next.delete(item.id);
                                  }
                                  return next;
                                });
                                if (e.target.checked && !qtys[item.id]) {
                                  setQtys(q => ({ ...q, [item.id]: remaining }));
                                }
                              }}
                              className="size-4 accent-primary"
                            />
                            <div className="min-w-0 flex-1">
                              <span className="block truncate text-sm">
                                {item.productName}
                              </span>
                              {item.returnedQty > 0 && (
                                <span className="
                                  text-[11px] font-medium text-amber-600
                                  dark:text-amber-400
                                "
                                >
                                  {item.returnedQty}
                                  {' '}
                                  ya devuelta(s)
                                </span>
                              )}
                            </div>
                            {fullyReturned
                              ? (
                                  <span className="
                                    px-2 text-[11px] font-medium
                                    text-muted-foreground
                                  "
                                  >
                                    Devuelto
                                  </span>
                                )
                              : (
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      disabled={!checked}
                                      onClick={() =>
                                        setQtys(q => ({
                                          ...q,
                                          [item.id]: Math.max(
                                            1,
                                            (q[item.id] ?? remaining) - 1,
                                          ),
                                        }))}
                                      className="
                                        size-6 rounded-sm border text-sm
                                        disabled:opacity-30
                                      "
                                    >
                                      −
                                    </button>
                                    <span className="
                                      w-8 text-center text-sm font-medium
                                      tabular-nums
                                    "
                                    >
                                      {qty}
                                    </span>
                                    <button
                                      type="button"
                                      disabled={!checked}
                                      onClick={() =>
                                        setQtys(q => ({
                                          ...q,
                                          [item.id]: Math.min(
                                            remaining,
                                            (q[item.id] ?? remaining) + 1,
                                          ),
                                        }))}
                                      className="
                                        size-6 rounded-sm border text-sm
                                        disabled:opacity-30
                                      "
                                    >
                                      +
                                    </button>
                                  </div>
                                )}
                            <span className="
                              w-20 text-right text-xs text-muted-foreground
                              tabular-nums
                            "
                            >
                              {fullyReturned
                                ? '—'
                                : isDamaged
                                  ? 'Reemplazo'
                                  : formatMoney(lineRefund(item, qty))}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Reason — destination is baked in */}
                    <div className="space-y-2">
                      <p className={labelCls}>Motivo</p>
                      <div className="
                        grid grid-cols-1 gap-2
                        sm:grid-cols-2
                      "
                      >
                        {RETURN_REASONS.map(r => (
                          <button
                            key={r.value}
                            type="button"
                            onClick={() => setReason(r.value)}
                            className={cn(
                              `
                                rounded-md border px-3 py-2 text-left text-sm
                                font-medium transition-colors
                              `,
                              reason === r.value
                                ? `
                                  border-primary/50 bg-primary/5 text-foreground
                                `
                                : `
                                  text-muted-foreground
                                  hover:bg-accent
                                `,
                            )}
                          >
                            {r.label}
                          </button>
                        ))}
                      </div>
                      {reasonMeta && (
                        <p className="text-xs text-muted-foreground">
                          {reasonMeta.effect}
                        </p>
                      )}
                    </div>

                    {/* A damaged exchange returns no cash, so we replace the
                        refund method + total with the merma note. */}
                    {isDamaged
                      ? (
                          <div className="
                            rounded-md border border-amber-500/40
                            bg-amber-500/10 px-3 py-2 text-xs text-amber-700
                          "
                          >
                            No se devuelve dinero: se entrega un reemplazo y el
                            producto dañado se registra como merma al costo.
                          </div>
                        )
                      : (
                          <>
                            {/* Refund — quick buttons for the configured methods */}
                            <div className="space-y-2">
                              <p className={labelCls}>Reembolso en</p>
                              <div className="flex flex-wrap gap-2">
                                {methods.map(m => (
                                  <button
                                    key={m}
                                    type="button"
                                    onClick={() => setRefundMethod(m)}
                                    className={cn(
                                      `
                                        rounded-md border px-3 py-1.5 text-sm
                                        font-medium transition-colors
                                      `,
                                      refundMethod === m
                                        ? `
                                          border-primary/50 bg-primary/5
                                          text-foreground
                                        `
                                        : `
                                          text-muted-foreground
                                          hover:bg-accent
                                        `,
                                    )}
                                  >
                                    {m}
                                  </button>
                                ))}
                              </div>
                              {refundIsCash && (
                                <p className="text-xs text-muted-foreground">
                                  Se registra la salida de efectivo en la caja
                                  abierta.
                                </p>
                              )}
                            </div>

                            <div className="
                              flex items-center justify-between rounded-md
                              border p-3 text-sm
                            "
                            >
                              <span className="text-muted-foreground">
                                Total a reembolsar
                              </span>
                              <span className="font-semibold tabular-nums">
                                {formatMoney(totalRefund)}
                              </span>
                            </div>
                          </>
                        )}

                    {submitError && (
                      <div className="
                        rounded-md border border-destructive/40
                        bg-destructive/10 px-3 py-2 text-sm text-destructive
                      "
                      >
                        {submitError}
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        variant="secondary"
                        onClick={closeReturn}
                        disabled={submitting}
                      >
                        Cancelar
                      </Button>
                      <Button
                        onClick={confirmReturn}
                        disabled={submitting || selectedCount === 0}
                      >
                        {submitting ? 'Procesando…' : 'Confirmar devolución'}
                      </Button>
                    </div>
                  </>
                )}
          </div>
        </div>
      )}
    </div>
  );
}
