'use client';

import type { ListSalesResult, Sale } from '@/actions/sales';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { listSales } from '@/actions/sales';
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

function formatMoney(value: string) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) {
    return value;
  }
  return moneyFmt.format(n);
}

export function SalesClient({
  initial,
  pageSize,
}: {
  initial: ListSalesResult;
  pageSize: number;
}) {
  const [rows, setRows] = useState<Sale[]>(initial.items);
  const [total, setTotal] = useState<number>(initial.total);
  const [page, setPage] = useState(0);

  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [payment, setPayment] = useState('all');
  const [search, setSearch] = useState('');
  const [cashierId, setCashierId] = useState('');

  const [pending, startTransition] = useTransition();
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRun = useRef(true);

  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(total / pageSize)),
    [total, pageSize],
  );

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      startTransition(async () => {
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
      });
    }, 250);
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
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

  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="space-y-4">
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
            </tr>
          </thead>
          <tbody>
            {rows.length === 0
              ? (
                  <tr>
                    <td
                      colSpan={6}
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
    </div>
  );
}
