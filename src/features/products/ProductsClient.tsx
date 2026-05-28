'use client';

import type { Product } from './actions';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import {
  createProduct,
  listProducts,

  softDeleteProduct,
  updateProduct,
} from './actions';

type ProductFormState = {
  name: string;
  barcode: string;
  price: string;
  cost: string;
  stock: string;
  category: string;
  unitType: 'unit' | 'kg';
  isPerishable: boolean;
  isWholesale: boolean;
  status: 'draft' | 'scheduled' | 'published' | 'archived';
};

const emptyForm: ProductFormState = {
  name: '',
  barcode: '',
  price: '',
  cost: '0',
  stock: '0',
  category: '',
  unitType: 'unit',
  isPerishable: false,
  isWholesale: false,
  status: 'published',
};

function toFormState(p: Product): ProductFormState {
  return {
    name: p.name,
    barcode: p.barcode ?? '',
    price: p.price,
    cost: p.cost,
    stock: String(p.stock),
    category: p.category ?? '',
    unitType: p.unitType,
    isPerishable: p.isPerishable,
    isWholesale: p.isWholesale,
    status: p.status,
  };
}

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const labelCls = 'text-sm font-medium';

export function ProductsClient({ initial }: { initial: Product[] }) {
  const [rows, setRows] = useState<Product[]>(initial);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductFormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setOpen(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setForm(toFormState(p));
    setError(null);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setEditing(null);
    setError(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const payload = {
      name: form.name,
      barcode: form.barcode.trim() === '' ? null : form.barcode.trim(),
      price: form.price,
      cost: form.cost || '0',
      stock: Number(form.stock || 0),
      category: form.category.trim() === '' ? null : form.category.trim(),
      unitType: form.unitType,
      isPerishable: form.isPerishable,
      isWholesale: form.isWholesale,
      status: form.status,
    };

    startTransition(async () => {
      try {
        if (editing) {
          const updated = await updateProduct(editing.id, payload);
          setRows(prev => prev.map(r => (r.id === updated.id ? updated : r)));
        } else {
          const created = await createProduct(payload);
          setRows(prev => [created, ...prev]);
        }
        close();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unexpected error');
      }
    });
  }

  function onDelete(p: Product) {
    if (!confirm(`Delete "${p.name}"?`)) {
      return;
    }
    startTransition(async () => {
      try {
        await softDeleteProduct(p.id);
        setRows(prev => prev.filter(r => r.id !== p.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unexpected error');
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
          placeholder="Search by name, barcode or category"
          className={cn(inputCls, 'max-w-md')}
        />
        <Button onClick={openCreate}>New product</Button>
        <div className="ml-auto text-sm text-muted-foreground">
          {rows.length}
          {' '}
          items · stock total
          {' '}
          {totalStock}
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Barcode</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2">Unit</th>
              <th className="px-3 py-2">Status</th>
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
                      {pending ? 'Loading…' : 'No products yet'}
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
                      <td className="px-3 py-2">{p.status}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openEdit(p)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => onDelete(p)}
                          >
                            Delete
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
              w-full max-w-2xl rounded-lg border bg-background p-6 shadow-lg
            "
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {editing ? 'Edit product' : 'New product'}
              </h2>
              <button
                type="button"
                onClick={close}
                className="
                  text-muted-foreground
                  hover:text-foreground
                "
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <form onSubmit={onSubmit} className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className={labelCls}>Name</label>
                <input
                  required
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>Barcode</label>
                <input
                  value={form.barcode}
                  onChange={e => setForm({ ...form, barcode: e.target.value })}
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>Category</label>
                <input
                  value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value })}
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>Price</label>
                <input
                  required
                  inputMode="decimal"
                  value={form.price}
                  onChange={e => setForm({ ...form, price: e.target.value })}
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>Cost</label>
                <input
                  inputMode="decimal"
                  value={form.cost}
                  onChange={e => setForm({ ...form, cost: e.target.value })}
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>Stock</label>
                <input
                  inputMode="numeric"
                  value={form.stock}
                  onChange={e => setForm({ ...form, stock: e.target.value })}
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>Unit</label>
                <select
                  value={form.unitType}
                  onChange={e =>
                    setForm({
                      ...form,
                      unitType: e.target.value as 'unit' | 'kg',
                    })}
                  className={inputCls}
                >
                  <option value="unit">unit</option>
                  <option value="kg">kg</option>
                </select>
              </div>

              <div>
                <label className={labelCls}>Status</label>
                <select
                  value={form.status}
                  onChange={e =>
                    setForm({
                      ...form,
                      status: e.target.value as ProductFormState['status'],
                    })}
                  className={inputCls}
                >
                  <option value="draft">draft</option>
                  <option value="scheduled">scheduled</option>
                  <option value="published">published</option>
                  <option value="archived">archived</option>
                </select>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isPerishable}
                  onChange={e =>
                    setForm({ ...form, isPerishable: e.target.checked })}
                />
                Perishable
              </label>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isWholesale}
                  onChange={e =>
                    setForm({ ...form, isWholesale: e.target.checked })}
                />
                Wholesale
              </label>

              {error && (
                <div className="
                  col-span-2 rounded-md bg-destructive/10 px-3 py-2 text-sm
                  text-destructive
                "
                >
                  {error}
                </div>
              )}

              <div className="col-span-2 mt-2 flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? 'Saving…' : editing ? 'Save changes' : 'Create'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
