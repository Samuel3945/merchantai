'use client';

import type {
  ListSalesResult,
  ReturnableItem,
  SaleListRow,
  SaleReturnDetail,
} from '@/actions/sales';
import type { ReturnReason } from '@/libs/sale-returns';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { listPaymentMethods } from '@/actions/payment-methods';
import { getSaleForReturn, listSales, processReturn } from '@/actions/sales';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const labelCls = 'text-xs font-medium text-muted-foreground';

const paymentOptions = [
  { value: 'all', label: 'Todos los pagos' },
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'transferencia', label: 'Transferencia / Nequi / Daviplata' },
];

const RETURN_REASONS: { value: ReturnReason; label: string }[] = [
  { value: 'customer_request', label: 'Cliente cambió de opinión' },
  { value: 'damaged', label: 'Producto dañado' },
  { value: 'wrong_product', label: 'Producto equivocado' },
  { value: 'price_error', label: 'Error de precio' },
  { value: 'duplicate', label: 'Cobro duplicado' },
  { value: 'other', label: 'Otro motivo' },
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

function lineRefund(item: ReturnableItem, qty: number) {
  const sub = Number.parseFloat(item.subtotal);
  if (!Number.isFinite(sub) || item.qty <= 0) {
    return 0;
  }
  return Math.round(((sub / item.qty) * qty) * 100) / 100;
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
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitSuccess, setSubmitSuccess] = useState('');

  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(total / pageSize)),
    [total, pageSize],
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

  function clearFilters() {
    setStart('');
    setEnd('');
    setPayment('all');
    setSearch('');
    setCashierId('');
    setPage(0);
  }

  async function openReturn(saleId: string) {
    setReturnSale(null);
    setSubmitError('');
    setSubmitSuccess('');
    setNotes('');
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
      setReturnSale({ id: saleId, total: '0', status: 'error', items: [] });
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
      const chosen = returnSale.items.filter(it => selected.has(it.id));
      const items = chosen.map((it) => {
        const remaining = remainingOf(it);
        const qty = Math.min(qtys[it.id] ?? remaining, remaining);
        return {
          saleItemId: it.id,
          qty,
          refundAmount: lineRefund(it, qty),
          restock: true,
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
        notes: notes || null,
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
          {' '}
          — el stock fue actualizado en inventario.
        </div>
      )}

      <div className="
        grid grid-cols-1 gap-3
        sm:grid-cols-2
        lg:grid-cols-6
      "
      >
        <div className="lg:col-span-1">
          <label className={labelCls}>Desde</label>
          <input
            type="date"
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              resetToFirstPage();
            }}
            className={inputCls}
          />
        </div>
        <div className="lg:col-span-1">
          <label className={labelCls}>Hasta</label>
          <input
            type="date"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value);
              resetToFirstPage();
            }}
            className={inputCls}
          />
        </div>
        <div className="lg:col-span-1">
          <label className={labelCls}>Pago</label>
          <select
            value={payment}
            onChange={(e) => {
              setPayment(e.target.value);
              resetToFirstPage();
            }}
            className={inputCls}
          >
            {paymentOptions.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="lg:col-span-1">
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
        <div className="lg:col-span-2">
          <label className={labelCls}>Buscar</label>
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetToFirstPage();
            }}
            placeholder="ID de venta o nombre de producto"
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
              <th className="px-3 py-2">ID de venta</th>
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
                  rows.map(s => (
                    <tr key={s.id} className="border-t">
                      <td className="px-3 py-2 whitespace-nowrap">
                        {dateFmt.format(new Date(s.createdAt))}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {s.id.slice(0, 8)}
                        …
                      </td>
                      <td className="px-3 py-2">{s.paymentType}</td>
                      <td className="px-3 py-2">{s.status}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {s.cashierId ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-medium">
                        {formatMoney(s.total)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={detailLoading}
                          onClick={() => openReturn(s.id)}
                        >
                          {s.hasReturn ? 'Dev. parcial' : 'Devolución'}
                        </Button>
                      </td>
                    </tr>
                  ))
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

      {/* ── Return modal ── */}
      {returnSale && (
        <div className="
          fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4
        "
        >
          <div className="
            w-full max-w-md space-y-4 rounded-lg border bg-background p-6
            shadow-xl
          "
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-semibold">Procesar devolución</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Venta #
                  {returnSale.id.slice(0, 6).toUpperCase()}
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
                    <div className="space-y-2">
                      <p className="
                        text-xs font-medium tracking-wider text-muted-foreground
                        uppercase
                      "
                      >
                        Selecciona qué se devuelve
                      </p>
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
                                : formatMoney(lineRefund(item, qty))}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelCls}>Motivo</label>
                        <select
                          value={reason}
                          onChange={e =>
                            setReason(e.target.value as ReturnReason)}
                          className={inputCls}
                        >
                          {RETURN_REASONS.map(r => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className={labelCls}>Reembolso en</label>
                        <select
                          value={refundMethod}
                          onChange={e => setRefundMethod(e.target.value)}
                          className={inputCls}
                        >
                          {methods.map(m => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className={labelCls}>Notas (opcional)</label>
                      <input
                        type="text"
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        placeholder="Detalle adicional…"
                        className={inputCls}
                      />
                    </div>

                    <div className="
                      rounded-md border border-amber-500/30 bg-amber-500/10 px-3
                      py-2 text-xs text-amber-700
                      dark:text-amber-400
                    "
                    >
                      {refundIsCash
                        ? 'Se restockea inventario y se registra la salida de efectivo en la caja abierta.'
                        : 'Se restockea inventario. El reembolso queda registrado en el método indicado.'}
                    </div>

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
                        disabled={submitting || selectedCount === 0}
                        onClick={confirmReturn}
                      >
                        {submitting ? 'Procesando…' : 'Confirmar devolución'}
                      </Button>
                      <Button variant="secondary" onClick={closeReturn}>
                        Cancelar
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
