'use client';

import type { Product } from './actions';
import type { AttrRow } from './AttributesEditor';
import type { UITier } from './WholesaleTiersEditor';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import {
  createProduct,
  listProducts,
  softDeleteProduct,
  updateProduct,
} from './actions';
import { categorizeProduct } from './ai-categorize';
import { AttributesEditor } from './AttributesEditor';
import { WholesaleTiersEditor } from './WholesaleTiersEditor';

type ProductStatus = 'draft' | 'scheduled' | 'published' | 'archived';

const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: 'Borrador',
  scheduled: 'Programado',
  published: 'Publicado',
  archived: 'Archivado',
};

type ProductFormState = {
  name: string;
  barcode: string;
  price: string;
  cost: string;
  category: string;
  unitType: 'unit' | 'kg';
  isPerishable: boolean;
  isWholesale: boolean;
  status: ProductStatus;
  publishAt: string;
  tiers: UITier[];
  attributes: AttrRow[];
  // Opening inventory — create-only.
  initialQty: string;
  initialCost: string;
  initialExpiresAt: string;
};

const emptyForm: ProductFormState = {
  name: '',
  barcode: '',
  price: '',
  cost: '0',
  category: '',
  unitType: 'unit',
  isPerishable: false,
  isWholesale: false,
  status: 'published',
  publishAt: '',
  tiers: [],
  attributes: [],
  initialQty: '',
  initialCost: '',
  initialExpiresAt: '',
};

function toFormState(p: Product): ProductFormState {
  const tiers = (p.wholesaleTiers as { minQty: number; price: string }[] | null) ?? [];
  const attrs = (p.attributes as Record<string, unknown> | null) ?? {};
  return {
    name: p.name,
    barcode: p.barcode ?? '',
    price: p.price,
    cost: p.cost,
    category: p.category ?? '',
    unitType: p.unitType,
    isPerishable: p.isPerishable,
    isWholesale: p.isWholesale,
    status: p.status,
    publishAt: p.publishAt ? new Date(p.publishAt).toISOString().slice(0, 16) : '',
    tiers: tiers.map(t => ({ minQty: String(t.minQty), price: String(t.price) })),
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value: String(value ?? ''),
    })),
    initialQty: '',
    initialCost: '',
    initialExpiresAt: '',
  };
}

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const labelCls = 'text-sm font-medium';

type AiState
  = | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'done'; remaining: number }
    | { status: 'no_credits' };

export type ProductFeatureFlags = {
  sellByWeight: boolean;
  wholesale: boolean;
  perishable: boolean;
};

export function ProductsClient({
  initial,
  features,
}: {
  initial: Product[];
  features: ProductFeatureFlags;
}) {
  const [rows, setRows] = useState<Product[]>(initial);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductFormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [ai, setAi] = useState<AiState>({ status: 'idle' });
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCategorized = useRef<string>('');

  useEffect(() => {
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
    }
    searchTimer.current = setTimeout(() => {
      startTransition(async () => {
        const data = await listProducts({ search });
        setRows(data);
      });
    }, 250);
    return () => {
      if (searchTimer.current) {
        clearTimeout(searchTimer.current);
      }
    };
  }, [search]);

  const totalStock = useMemo(
    () => rows.reduce((acc, r) => acc + r.stock, 0),
    [rows],
  );

  const priceNum = Number.parseFloat(form.price) || 0;
  const initialQtyNum = Number.parseFloat(form.initialQty) || 0;
  const initialCostNum = Number.parseFloat(form.initialCost) || 0;

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setAi({ status: 'idle' });
    setAiSuggestions([]);
    lastCategorized.current = '';
    setOpen(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setForm(toFormState(p));
    setError(null);
    setAi({ status: 'idle' });
    setAiSuggestions([]);
    lastCategorized.current = '';
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setEditing(null);
    setError(null);
  }

  // AI categorization — fires when the user finishes typing the name (create
  // mode only). Consumes one credit, so it's gated on a meaningful name and
  // never re-runs for the same value.
  function runCategorize() {
    const name = form.name.trim();
    if (editing || name.length < 3 || name === lastCategorized.current) {
      return;
    }
    lastCategorized.current = name;
    setAi({ status: 'loading' });
    startTransition(async () => {
      try {
        const res = await categorizeProduct(name);
        if (!res.ok) {
          setAi(res.reason === 'no_credits' ? { status: 'no_credits' } : { status: 'idle' });
          return;
        }
        setAiSuggestions(res.attributes.map(a => a.key).filter(Boolean));
        setForm(f => ({
          ...f,
          category: f.category.trim() === '' ? res.category : f.category,
          attributes:
            f.attributes.length === 0
              ? res.attributes.filter(a => a.key.trim() !== '')
              : f.attributes,
        }));
        setAi({ status: 'done', remaining: res.remaining });
      } catch {
        setAi({ status: 'idle' });
      }
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const attributes = Object.fromEntries(
      form.attributes
        .map(a => [a.key.trim(), a.value.trim()] as const)
        .filter(([k]) => k !== ''),
    );

    const wholesaleTiers = form.isWholesale
      ? form.tiers
          .map(t => ({ minQty: Number.parseInt(t.minQty, 10), price: t.price.trim() }))
          .filter(t => Number.isFinite(t.minQty) && t.minQty >= 2 && t.price !== '')
      : null;

    const publishAt
      = form.status === 'scheduled' && form.publishAt
        ? new Date(form.publishAt)
        : null;

    const common = {
      name: form.name,
      barcode: form.barcode.trim() === '' ? null : form.barcode.trim(),
      price: form.price,
      cost: form.cost || '0',
      category: form.category.trim() === '' ? null : form.category.trim(),
      unitType: form.unitType,
      isPerishable: form.isPerishable,
      isWholesale: form.isWholesale,
      wholesaleTiers,
      attributes,
      status: form.status,
      publishAt,
    };

    startTransition(async () => {
      try {
        if (editing) {
          const updated = await updateProduct(editing.id, common);
          setRows(prev => prev.map(r => (r.id === updated.id ? updated : r)));
        } else {
          const created = await createProduct({
            ...common,
            initialQty: initialQtyNum,
            initialCost: form.initialCost.trim() === '' ? null : form.initialCost.trim(),
            initialExpiresAt:
              form.initialExpiresAt.trim() === '' ? null : form.initialExpiresAt.trim(),
          });
          setRows(prev => [created, ...prev]);
        }
        close();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  function onDelete(p: Product) {
    // eslint-disable-next-line no-alert -- native confirm matches the existing delete UX
    if (!globalThis.confirm(`¿Eliminar "${p.name}"?`)) {
      return;
    }
    startTransition(async () => {
      try {
        await softDeleteProduct(p.id);
        setRows(prev => prev.filter(r => r.id !== p.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por nombre, código de barras o categoría"
          className={cn(inputCls, 'max-w-md')}
        />
        <Button onClick={openCreate}>Nuevo artículo</Button>
        <div className="ml-auto text-sm text-muted-foreground">
          {rows.length}
          {' '}
          artículos · stock total
          {' '}
          {totalStock}
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Nombre</th>
              <th className="px-3 py-2">Código de barras</th>
              <th className="px-3 py-2">Categoría</th>
              <th className="px-3 py-2 text-right">Precio</th>
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2">Unidad</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0
              ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      {pending ? 'Cargando…' : 'Aún no hay productos'}
                    </td>
                  </tr>
                )
              : (
                  rows.map(p => (
                    <tr key={p.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{p.name}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {p.barcode ?? '—'}
                      </td>
                      <td className="px-3 py-2">{p.category ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{p.price}</td>
                      <td className="px-3 py-2 text-right">{p.stock}</td>
                      <td className="px-3 py-2">{p.unitType}</td>
                      <td className="px-3 py-2">{STATUS_LABELS[p.status]}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openEdit(p)}
                          >
                            Editar
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => onDelete(p)}
                          >
                            Eliminar
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
          </tbody>
        </table>
      </div>

      {open && (
        <div
          className="
            fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4
          "
          role="dialog"
          aria-modal="true"
          onClick={close}
        >
          <div
            className="
              max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border
              bg-background p-6 shadow-lg
            "
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {editing ? 'Editar artículo' : 'Nuevo artículo'}
              </h2>
              <button
                type="button"
                onClick={close}
                className="
                  text-muted-foreground
                  hover:text-foreground
                "
                aria-label="Cerrar"
              >
                ✕
              </button>
            </div>

            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <label className={labelCls}>Nombre *</label>
                <input
                  required
                  autoFocus
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  onBlur={runCategorize}
                  className={cn(inputCls, 'mt-1')}
                />
              </div>

              <div>
                <label className={labelCls}>Código de barras</label>
                <input
                  value={form.barcode}
                  onChange={e => setForm({ ...form, barcode: e.target.value })}
                  className={cn(inputCls, 'mt-1')}
                />
              </div>

              {features.sellByWeight && (
                <div>
                  <label className={labelCls}>Se vende por</label>
                  <div className="mt-1 grid grid-cols-2 gap-2">
                    {(['unit', 'kg'] as const).map(u => (
                      <button
                        key={u}
                        type="button"
                        onClick={() => setForm({ ...form, unitType: u })}
                        className={cn(
                          `
                            h-10 rounded-md border text-sm font-medium
                            transition-colors
                          `,
                          form.unitType === u
                            ? 'border-primary bg-primary/10 text-primary'
                            : `
                              border-input text-muted-foreground
                              hover:bg-accent
                            `,
                        )}
                      >
                        {u === 'unit' ? 'Unidad' : 'Kg'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {(features.wholesale || features.perishable) && (
                <div className="flex flex-wrap gap-2">
                  {features.wholesale && (
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, isWholesale: !form.isWholesale })}
                      className={cn(
                        `
                          rounded-md border px-3 py-2 text-xs font-semibold
                          transition-colors
                        `,
                        form.isWholesale
                          ? 'border-primary bg-primary/10 text-primary'
                          : `
                            border-input text-muted-foreground
                            hover:bg-accent
                          `,
                      )}
                    >
                      Por mayor
                    </button>
                  )}
                  {features.perishable && (
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, isPerishable: !form.isPerishable })}
                      title="Marca productos que se vencen para registrar caducidad por lote."
                      className={cn(
                        `
                          rounded-md border px-3 py-2 text-xs font-semibold
                          transition-colors
                        `,
                        form.isPerishable
                          ? 'border-primary bg-primary/10 text-primary'
                          : `
                            border-input text-muted-foreground
                            hover:bg-accent
                          `,
                      )}
                    >
                      Se vence
                    </button>
                  )}
                </div>
              )}

              <div>
                <label className={labelCls}>
                  {form.unitType === 'kg' ? 'Precio por 1 kg *' : 'Precio por unidad *'}
                </label>
                <input
                  required
                  inputMode="decimal"
                  value={form.price}
                  onChange={e => setForm({ ...form, price: e.target.value })}
                  className={cn(inputCls, 'mt-1')}
                />
              </div>

              {features.wholesale && form.isWholesale && (
                <WholesaleTiersEditor
                  price={priceNum}
                  tiers={form.tiers}
                  onChange={tiers => setForm(f => ({ ...f, tiers }))}
                />
              )}

              {!editing && (
                <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                  <p className="
                    text-xs font-semibold tracking-wider text-muted-foreground
                    uppercase
                  "
                  >
                    Inventario inicial (opcional)
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Si ya tienes unidades, regístralas aquí — quedará como movimiento de entrada.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-muted-foreground">Cantidad</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={form.initialQty}
                        onChange={e => setForm({ ...form, initialQty: e.target.value })}
                        placeholder="0"
                        className={cn(inputCls, 'mt-1')}
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground">
                        Costo unitario de ingreso
                      </label>
                      <input
                        type="number"
                        min="0"
                        inputMode="decimal"
                        value={form.initialCost}
                        onChange={e => setForm({ ...form, initialCost: e.target.value })}
                        placeholder="0"
                        className={cn(inputCls, 'mt-1')}
                      />
                    </div>
                  </div>
                  {features.perishable && form.isPerishable && (
                    <div>
                      <label className="
                        text-[11px] font-semibold tracking-wider
                        text-muted-foreground uppercase
                      "
                      >
                        Caducidad del lote inicial
                        {' '}
                        {initialQtyNum > 0 ? '*' : '(si registras stock inicial)'}
                      </label>
                      <input
                        type="date"
                        value={form.initialExpiresAt}
                        min={new Date().toISOString().slice(0, 10)}
                        onChange={e => setForm({ ...form, initialExpiresAt: e.target.value })}
                        className={cn(inputCls, 'mt-1')}
                      />
                    </div>
                  )}
                  {initialQtyNum > 0 && initialCostNum > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Total entrada:
                      {' '}
                      <strong>
                        $
                        {Math.round(initialQtyNum * initialCostNum).toLocaleString('es-CO')}
                      </strong>
                      {priceNum > 0 && (
                        <>
                          {' '}
                          · Margen estimado:
                          {' '}
                          <strong>
                            {Math.round(((priceNum - initialCostNum) / priceNum) * 100)}
                            %
                          </strong>
                        </>
                      )}
                    </p>
                  )}
                </div>
              )}

              <AttributesEditor
                suggestions={aiSuggestions}
                attributes={form.attributes}
                onChange={attributes => setForm(f => ({ ...f, attributes }))}
              />

              <div>
                <label className={labelCls}>Publicación</label>
                <div className="mt-1 grid grid-cols-4 gap-2">
                  {(['draft', 'scheduled', 'published', 'archived'] as ProductStatus[]).map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setForm({ ...form, status: s })}
                      className={cn(
                        `
                          rounded-md border p-2 text-xs font-semibold
                          transition-colors
                        `,
                        form.status === s
                          ? 'border-primary bg-primary/10 text-primary'
                          : `
                            border-input text-muted-foreground
                            hover:bg-accent
                          `,
                      )}
                    >
                      {STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>
                {form.status === 'scheduled' && (
                  <input
                    type="datetime-local"
                    value={form.publishAt}
                    onChange={e => setForm({ ...form, publishAt: e.target.value })}
                    className={cn(inputCls, 'mt-2')}
                  />
                )}
              </div>

              {!editing && (
                <div className="
                  rounded-md border bg-muted/30 px-3 py-2 text-xs
                  text-muted-foreground
                "
                >
                  {ai.status === 'loading'
                    ? 'La IA está categorizando este producto…'
                    : ai.status === 'done'
                      ? `Categoría sugerida por IA aplicada · ${ai.remaining} créditos restantes.`
                      : ai.status === 'no_credits'
                        ? 'Sin créditos de IA: completa la categoría manualmente.'
                        : 'La IA categorizará este producto al crearlo (consume 1 crédito).'}
                </div>
              )}

              {error && (
                <div className="
                  rounded-md bg-destructive/10 px-3 py-2 text-sm
                  text-destructive
                "
                >
                  {error}
                </div>
              )}

              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={close}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear artículo'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
