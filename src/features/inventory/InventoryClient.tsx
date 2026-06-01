'use client';

import type { InventoryProduct, ListMovementsParams, SmartStockSuggestion } from '@/actions/inventory';
import { useEffect, useState, useTransition } from 'react';
import {
  getInventoryProducts,
  getSmartStockSuggestion,

  listMovements,

  recordMovement,

} from '@/actions/inventory';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';

// ── Shared styles ────────────────────────────────────────────────────────

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-sm font-medium';

const STATUS_COLORS: Record<string, string> = {
  ok: 'bg-green-500',
  low: 'bg-yellow-500',
  critical: 'bg-red-500',
};

const STATUS_LABELS: Record<string, string> = {
  ok: 'OK',
  low: 'Bajo',
  critical: 'Agotado',
};

const REASON_LABELS: Record<string, string> = {
  purchase: 'Compra',
  sale: 'Venta',
  return_sale: 'Devolución',
  spoiled: 'Vencido',
  damaged: 'Dañado',
  lost: 'Perdido',
  manual: 'Manual',
  inventory_count: 'Conteo físico',
};

type MovementRow = Awaited<ReturnType<typeof listMovements>>[number];

// ── Modal wrapper ────────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="
        fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4
      "
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="
          w-full max-w-lg rounded-lg border bg-background p-6 shadow-lg
        "
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="
              text-muted-foreground
              hover:text-foreground
            "
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Entry modal ──────────────────────────────────────────────────────────

function EntryModal({
  product,
  onClose,
  onSuccess,
}: {
  product: InventoryProduct;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [qty, setQty] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) {
      setError('Cantidad inválida');
      return;
    }
    startTransition(async () => {
      try {
        await recordMovement({
          productId: product.id,
          type: 'entry',
          qty: q,
          reason: 'purchase',
          unitCost: unitCost.trim() || null,
          supplierId: supplierId.trim() || null,
          expiresAt: expiresAt || null,
        });
        onSuccess();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  return (
    <Modal title={`Entrada de stock — ${product.name}`} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className={labelCls}>Cantidad</label>
          <input
            required
            type="number"
            min="1"
            value={qty}
            onChange={e => setQty(e.target.value)}
            className={inputCls}
            autoFocus
          />
        </div>
        <div>
          <label className={labelCls}>Costo unitario</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={unitCost}
            onChange={e => setUnitCost(e.target.value)}
            className={inputCls}
            placeholder="Opcional"
          />
        </div>
        <div>
          <label className={labelCls}>Proveedor</label>
          <input
            value={supplierId}
            onChange={e => setSupplierId(e.target.value)}
            className={inputCls}
            placeholder="Nombre o ID (opcional)"
          />
        </div>
        {product.isPerishable && (
          <div>
            <label className={labelCls}>Fecha de caducidad</label>
            <input
              type="date"
              value={expiresAt}
              onChange={e => setExpiresAt(e.target.value)}
              className={inputCls}
            />
          </div>
        )}
        {error && (
          <div className="
            rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive
          "
          >
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Guardando...' : 'Registrar entrada'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Exit / Loss modal ────────────────────────────────────────────────────

function ExitModal({
  product,
  onClose,
  onSuccess,
}: {
  product: InventoryProduct;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<'spoiled' | 'damaged' | 'lost' | 'manual'>('spoiled');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) {
      setError('Cantidad inválida');
      return;
    }
    startTransition(async () => {
      try {
        await recordMovement({
          productId: product.id,
          type: 'exit',
          qty: q,
          reason,
          notes: notes.trim() || null,
        });
        onSuccess();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  return (
    <Modal title={`Salida / Pérdida — ${product.name}`} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className={labelCls}>Cantidad</label>
          <input
            required
            type="number"
            min="1"
            value={qty}
            onChange={e => setQty(e.target.value)}
            className={inputCls}
            autoFocus
          />
        </div>
        <div>
          <label className={labelCls}>Motivo</label>
          <select
            value={reason}
            onChange={e => setReason(e.target.value as typeof reason)}
            className={inputCls}
          >
            <option value="spoiled">Vencido</option>
            <option value="damaged">Dañado</option>
            <option value="lost">Perdido</option>
            <option value="manual">Otro</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Notas</label>
          <input
            value={notes}
            onChange={e => setNotes(e.target.value)}
            className={inputCls}
            placeholder="Opcional"
          />
        </div>
        {error && (
          <div className="
            rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive
          "
          >
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="destructive" disabled={pending}>
            {pending ? 'Guardando...' : 'Registrar salida'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Physical count modal ─────────────────────────────────────────────────

function CountModal({
  product,
  onClose,
  onSuccess,
}: {
  product: InventoryProduct;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [qty, setQty] = useState(String(product.stock));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const q = Number(qty);
    if (!Number.isFinite(q) || q < 0) {
      setError('Cantidad inválida');
      return;
    }
    startTransition(async () => {
      try {
        await recordMovement({
          productId: product.id,
          type: 'adjustment',
          qty: q,
          reason: 'inventory_count',
        });
        onSuccess();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  const diff = Number(qty) - product.stock;

  return (
    <Modal title={`Conteo físico — ${product.name}`} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="text-sm text-muted-foreground">
          Stock actual en sistema:
          {' '}
          <strong>{product.stock}</strong>
        </div>
        <div>
          <label className={labelCls}>Cantidad contada</label>
          <input
            required
            type="number"
            min="0"
            value={qty}
            onChange={e => setQty(e.target.value)}
            className={inputCls}
            autoFocus
          />
        </div>
        {Number.isFinite(diff) && diff !== 0 && (
          <div
            className={cn(
              'rounded-md px-3 py-2 text-sm',
              diff > 0
                ? 'bg-green-500/10 text-green-700'
                : `bg-red-500/10 text-red-700`,
            )}
          >
            Diferencia:
            {' '}
            {diff > 0 ? '+' : ''}
            {diff}
            {' '}
            unidades
          </div>
        )}
        {error && (
          <div className="
            rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive
          "
          >
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Ajustando...' : 'Ajustar stock'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── AI Recommendation modal ──────────────────────────────────────────────

function AiModal({
  product,
  onClose,
}: {
  product: InventoryProduct;
  onClose: () => void;
}) {
  const [data, setData] = useState<SmartStockSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function load() {
    startTransition(async () => {
      setError(null);
      try {
        const result = await getSmartStockSuggestion(product.id);
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  // Fetch the suggestion once when the modal opens. Calling load() during
  // render looped forever whenever the request failed.
  useEffect(() => {
    load();
    // eslint-disable-next-line react/exhaustive-deps
  }, []);

  return (
    <Modal title={`Recomendación IA — ${product.name}`} onClose={onClose}>
      {pending && !data && (
        <div className="py-8 text-center text-muted-foreground">Analizando ventas...</div>
      )}
      {error && (
        <div className="
          rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive
        "
        >
          {error}
        </div>
      )}
      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Ventas promedio/día</div>
              <div className="text-xl font-semibold">{data.avgDailySales}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Lead time estimado</div>
              <div className="text-xl font-semibold">
                {data.suggestedLeadTimeDays}
                {' '}
                días
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Min stock sugerido</div>
              <div className="text-xl font-semibold">{data.suggestedMinStock}</div>
              <div className="text-xs text-muted-foreground">
                Actual:
                {' '}
                {product.minStock}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Max stock recomendado</div>
              <div className="text-xl font-semibold">{data.suggestedMaxStock}</div>
              <div className="text-xs text-muted-foreground">
                Actual:
                {' '}
                {product.stockMaxRecommended ?? '—'}
              </div>
            </div>
          </div>
          <div className="rounded-md bg-muted p-3 text-sm">{data.reasoning}</div>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Cerrar
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── History panel ────────────────────────────────────────────────────────

function HistoryPanel() {
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function doLoad(p: number = 1) {
    startTransition(async () => {
      const params: ListMovementsParams = { page: p, pageSize: 50 };
      if (from) {
        params.from = from;
      }
      if (to) {
        params.to = to;
      }
      try {
        const rows = await listMovements(params);
        setMovements(rows);
        setPage(p);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'No se pudo cargar el historial',
        );
      }
    });
  }

  // Load the first page once on mount. Doing this in render (the previous
  // approach) fired a transition during render and could loop on failure.
  useEffect(() => {
    doLoad(1);
    // eslint-disable-next-line react/exhaustive-deps
  }, []);

  const dateFmt = new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Bogota',
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <div>
          <label className="text-xs text-muted-foreground">Desde</label>
          <input
            type="date"
            value={from}
            onChange={e => setFrom(e.target.value)}
            className={cn(inputCls, 'w-40')}
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Hasta</label>
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            className={cn(inputCls, 'w-40')}
          />
        </div>
        <div className="flex items-end">
          <Button size="sm" onClick={() => doLoad(1)} disabled={pending}>
            {pending ? 'Cargando...' : 'Filtrar'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="
          rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2
          text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Fecha</th>
              <th className="px-3 py-2">Producto</th>
              <th className="px-3 py-2">Tipo</th>
              <th className="px-3 py-2 text-right">Cant.</th>
              <th className="px-3 py-2">Motivo</th>
              <th className="px-3 py-2 text-right">Costo u.</th>
            </tr>
          </thead>
          <tbody>
            {movements.length === 0
              ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      {pending ? 'Cargando...' : 'Sin movimientos'}
                    </td>
                  </tr>
                )
              : (
                  movements.map(m => (
                    <tr key={m.id} className="border-t">
                      <td className="px-3 py-2 text-xs">
                        {dateFmt.format(new Date(m.createdAt))}
                      </td>
                      <td className="px-3 py-2">{m.currentName ?? m.snapshotName ?? '—'}</td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            `
                              inline-block rounded-sm px-1.5 py-0.5 text-xs
                              font-medium
                            `,
                            m.type === 'entry' && `
                              bg-green-500/10 text-green-700
                            `,
                            m.type === 'exit' && 'bg-red-500/10 text-red-700',
                            m.type === 'adjustment' && `
                              bg-blue-500/10 text-blue-700
                            `,
                          )}
                        >
                          {m.type === 'entry' ? 'Entrada' : m.type === 'exit' ? 'Salida' : 'Ajuste'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {m.type === 'entry' ? '+' : m.type === 'exit' ? '-' : '='}
                        {m.qty}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {REASON_LABELS[m.reason ?? ''] ?? m.reason ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {m.unitCost ?? '—'}
                      </td>
                    </tr>
                  ))
                )}
          </tbody>
        </table>
      </div>

      {movements.length >= 50 && (
        <div className="flex gap-2">
          {page > 1 && (
            <Button size="sm" variant="secondary" onClick={() => doLoad(page - 1)}>
              Anterior
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => doLoad(page + 1)}>
            Siguiente
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────

export function InventoryClient({
  initialProducts,
}: {
  initialProducts: InventoryProduct[];
}) {
  const [products, setProducts] = useState(initialProducts);
  const [tab, setTab] = useState<'stock' | 'history'>('stock');
  const [search, setSearch] = useState('');
  const [pending, startTransition] = useTransition();

  // Modal state
  const [entryProduct, setEntryProduct] = useState<InventoryProduct | null>(null);
  const [exitProduct, setExitProduct] = useState<InventoryProduct | null>(null);
  const [countProduct, setCountProduct] = useState<InventoryProduct | null>(null);
  const [aiProduct, setAiProduct] = useState<InventoryProduct | null>(null);

  function reload() {
    startTransition(async () => {
      const data = await getInventoryProducts();
      setProducts(data);
    });
  }

  const filtered = search.trim()
    ? products.filter(
        p =>
          p.name.toLowerCase().includes(search.toLowerCase())
          || (p.category ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : products;

  const criticalCount = products.filter(p => p.status === 'critical').length;
  const lowCount = products.filter(p => p.status === 'low').length;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="
        grid grid-cols-2 gap-3
        sm:grid-cols-4
      "
      >
        <div className="rounded-md border bg-background p-3">
          <div className="text-xs text-muted-foreground">Productos</div>
          <div className="text-2xl font-semibold">{products.length}</div>
        </div>
        <div className="rounded-md border bg-background p-3">
          <div className="text-xs text-muted-foreground">Stock total</div>
          <div className="text-2xl font-semibold">
            {products.reduce((s, p) => s + p.stock, 0)}
          </div>
        </div>
        <div className="rounded-md border bg-background p-3">
          <div className="text-xs text-muted-foreground">Stock bajo</div>
          <div className="text-2xl font-semibold text-yellow-600">{lowCount}</div>
        </div>
        <div className="rounded-md border bg-background p-3">
          <div className="text-xs text-muted-foreground">Agotados</div>
          <div className="text-2xl font-semibold text-red-600">{criticalCount}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        <button
          type="button"
          onClick={() => setTab('stock')}
          className={cn(
            'px-4 py-2 text-sm font-medium transition-colors',
            tab === 'stock'
              ? 'border-b-2 border-foreground text-foreground'
              : `
                text-muted-foreground
                hover:text-foreground
              `,
          )}
        >
          Stock
        </button>
        <button
          type="button"
          onClick={() => setTab('history')}
          className={cn(
            'px-4 py-2 text-sm font-medium transition-colors',
            tab === 'history'
              ? 'border-b-2 border-foreground text-foreground'
              : `
                text-muted-foreground
                hover:text-foreground
              `,
          )}
        >
          Historial
        </button>
      </div>

      {tab === 'stock' && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por nombre o categoría"
              className={cn(inputCls, 'max-w-md')}
            />
          </div>

          <div className="overflow-x-auto rounded-md border bg-background">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase">
                <tr>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Producto</th>
                  <th className="px-3 py-2">Categoría</th>
                  <th className="px-3 py-2 text-right">Stock</th>
                  <th className="px-3 py-2 text-right">Min</th>
                  <th className="px-3 py-2 text-right">Max rec.</th>
                  <th className="px-3 py-2">Unidad</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0
                  ? (
                      <tr>
                        <td
                          colSpan={8}
                          className="
                            px-3 py-8 text-center text-muted-foreground
                          "
                        >
                          {pending ? 'Cargando...' : 'Sin productos'}
                        </td>
                      </tr>
                    )
                  : (
                      filtered.map(p => (
                        <tr key={p.id} className="border-t">
                          <td className="px-3 py-2">
                            <span className="flex items-center gap-1.5">
                              <span
                                className={cn(
                                  'inline-block size-2.5 rounded-full',
                                  STATUS_COLORS[p.status],
                                )}
                              />
                              <span className="text-xs">{STATUS_LABELS[p.status]}</span>
                            </span>
                          </td>
                          <td className="px-3 py-2 font-medium">{p.name}</td>
                          <td className="px-3 py-2 text-xs">{p.category ?? '—'}</td>
                          <td className="px-3 py-2 text-right font-mono">{p.stock}</td>
                          <td className="px-3 py-2 text-right font-mono text-xs">
                            {p.minStock}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs">
                            {p.stockMaxRecommended ?? '—'}
                          </td>
                          <td className="px-3 py-2 text-xs">{p.unitType}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap justify-end gap-1">
                              <Button size="sm" onClick={() => setEntryProduct(p)}>
                                Entrada
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => setExitProduct(p)}
                              >
                                Salida
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setCountProduct(p)}
                              >
                                Conteo
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setAiProduct(p)}
                              >
                                IA
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'history' && <HistoryPanel />}

      {/* Modals */}
      {entryProduct && (
        <EntryModal
          product={entryProduct}
          onClose={() => setEntryProduct(null)}
          onSuccess={reload}
        />
      )}
      {exitProduct && (
        <ExitModal
          product={exitProduct}
          onClose={() => setExitProduct(null)}
          onSuccess={reload}
        />
      )}
      {countProduct && (
        <CountModal
          product={countProduct}
          onClose={() => setCountProduct(null)}
          onSuccess={reload}
        />
      )}
      {aiProduct && (
        <AiModal product={aiProduct} onClose={() => setAiProduct(null)} />
      )}
    </div>
  );
}
