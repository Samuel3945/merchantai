'use client';

import type {
  ProductOption,
  SupplierListItem,
  SupplierProductRef,
  SupplierWithProducts,
} from './actions';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  createSupplier,
  listSupplierProductOptions,
  updateSupplier,
} from './actions';

type SupplierFormState = {
  name: string;
  phone: string;
  email: string;
};

const emptyForm: SupplierFormState = {
  name: '',
  phone: '',
  email: '',
};

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const labelCls = 'text-sm font-medium';

function nullify(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Create / edit modal for a supplier. We only ask for what it takes to reach
 * and identify the supplier — name plus at least one contact (phone or email) —
 * and which products they provide, so the agent can find who to restock from.
 *
 * Used both from the Proveedores view and from Caja's "quick create" flow — in
 * the quick flow it stays mounted on top of the movement modal and reports the
 * saved row back via onSaved so the caller can auto-select it.
 */
export function SupplierModal(props: {
  editing: SupplierListItem | null;
  onClose: () => void;
  onSaved: (supplier: SupplierWithProducts) => void;
}) {
  const { editing } = props;
  const [form, setForm] = useState<SupplierFormState>(() =>
    editing
      ? { name: editing.name, phone: editing.phone ?? '', email: editing.email ?? '' }
      : emptyForm,
  );
  const [products, setProducts] = useState<SupplierProductRef[]>(
    () => editing?.products ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        props.onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const hasContact = form.phone.trim() !== '' || form.email.trim() !== '';

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!hasContact) {
      setError('Indica al menos un teléfono o un correo para contactar al proveedor');
      return;
    }

    const payload = {
      name: form.name.trim(),
      phone: nullify(form.phone),
      email: nullify(form.email),
      productIds: products.map(p => p.id),
    };

    startTransition(async () => {
      try {
        const saved = editing
          ? await updateSupplier(editing.id, payload)
          : await createSupplier(payload);
        props.onSaved(saved);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  return (
    <div
      className="
        fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4
      "
      role="dialog"
      aria-modal="true"
      onClick={props.onClose}
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
            {editing ? 'Editar proveedor' : 'Nuevo proveedor'}
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            className="
              text-muted-foreground
              hover:text-foreground
            "
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        <form onSubmit={onSubmit} className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className={labelCls}>Nombre proveedor *</label>
            <input
              required
              autoFocus
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className={inputCls}
            />
          </div>

          <div>
            <label className={labelCls}>Teléfono</label>
            <input
              inputMode="tel"
              value={form.phone}
              onChange={e => setForm({ ...form, phone: e.target.value })}
              className={inputCls}
            />
          </div>

          <div>
            <label className={labelCls}>Correo</label>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              className={inputCls}
            />
          </div>

          <p className="col-span-2 -mt-2 text-xs text-muted-foreground">
            Indica al menos un teléfono o un correo para poder contactarlo.
          </p>

          <div className="col-span-2">
            <label className={labelCls}>Productos que provee</label>
            <ProductPicker selected={products} onChange={setProducts} />
            <p className="mt-1 text-xs text-muted-foreground">
              Cuando un producto se agote, podrás ver quién lo provee y pedir más.
            </p>
          </div>

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
            <Button type="button" variant="secondary" onClick={props.onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || !hasContact}>
              {pending ? 'Guardando…' : 'Guardar proveedor'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Searchable multi-select for the products a supplier provides. Selected items
 * show as removable chips; the search box lists matching products (the org's
 * catalog, capped) that aren't selected yet.
 */
function ProductPicker(props: {
  selected: SupplierProductRef[];
  onChange: (next: SupplierProductRef[]) => void;
}) {
  const { selected, onChange } = props;
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setLoading(true);
      listSupplierProductOptions({ search: query })
        .then(setOptions)
        .catch(() => setOptions([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [query]);

  const selectedIds = new Set(selected.map(p => p.id));
  const available = options.filter(o => !selectedIds.has(o.id));

  function add(opt: ProductOption) {
    onChange([...selected, { id: opt.id, name: opt.name }]);
  }

  function remove(id: string) {
    onChange(selected.filter(p => p.id !== id));
  }

  return (
    <div className="mt-1 space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map(p => (
            <span
              key={p.id}
              className="
                inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5
                text-xs
              "
            >
              {p.name}
              <button
                type="button"
                onClick={() => remove(p.id)}
                className="
                  text-muted-foreground
                  hover:text-foreground
                "
                aria-label={`Quitar ${p.name}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        type="search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Buscar producto por nombre o código…"
        className={inputCls}
      />

      <div className="max-h-40 overflow-y-auto rounded-md border">
        {loading
          ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">Cargando…</div>
            )
          : available.length === 0
            ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {query.trim() ? 'Sin resultados' : 'No hay más productos'}
                </div>
              )
            : (
                available.map(o => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => add(o)}
                    className="
                      block w-full px-3 py-1.5 text-left text-sm
                      hover:bg-muted
                    "
                  >
                    {o.name}
                  </button>
                ))
              )}
      </div>
    </div>
  );
}
