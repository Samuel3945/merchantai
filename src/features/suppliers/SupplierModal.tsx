'use client';

import type { Supplier, SupplierListItem } from './actions';
import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import { createSupplier, updateSupplier } from './actions';

type SupplierFormState = {
  name: string;
  company: string;
  phone: string;
  email: string;
  city: string;
  address: string;
  taxId: string;
  notes: string;
};

const emptyForm: SupplierFormState = {
  name: '',
  company: '',
  phone: '',
  email: '',
  city: '',
  address: '',
  taxId: '',
  notes: '',
};

function toFormState(s: SupplierListItem): SupplierFormState {
  return {
    name: s.name,
    company: s.company ?? '',
    phone: s.phone ?? '',
    email: s.email ?? '',
    city: s.city ?? '',
    address: s.address ?? '',
    taxId: s.taxId ?? '',
    notes: s.notes ?? '',
  };
}

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const labelCls = 'text-sm font-medium';

function nullify(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Create / edit modal for a supplier. Used both from the Proveedores view and
 * from Caja's "quick create" flow — in the quick flow it stays mounted on top
 * of the movement modal and reports the saved row back via onSaved so the caller
 * can auto-select it.
 */
export function SupplierModal(props: {
  editing: SupplierListItem | null;
  onClose: () => void;
  onSaved: (supplier: Supplier) => void;
}) {
  const { editing } = props;
  const [form, setForm] = useState<SupplierFormState>(() =>
    editing ? toFormState(editing) : emptyForm,
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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const payload = {
      name: form.name.trim(),
      company: nullify(form.company),
      phone: nullify(form.phone),
      email: nullify(form.email),
      city: nullify(form.city),
      address: nullify(form.address),
      taxId: nullify(form.taxId),
      notes: nullify(form.notes),
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
          max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border
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
            <label className={labelCls}>Empresa</label>
            <input
              value={form.company}
              onChange={e => setForm({ ...form, company: e.target.value })}
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

          <div>
            <label className={labelCls}>Ciudad</label>
            <input
              value={form.city}
              onChange={e => setForm({ ...form, city: e.target.value })}
              className={inputCls}
            />
          </div>

          <div className="col-span-2">
            <label className={labelCls}>Dirección</label>
            <input
              value={form.address}
              onChange={e => setForm({ ...form, address: e.target.value })}
              className={inputCls}
            />
          </div>

          <div className="col-span-2">
            <label className={labelCls}>NIT</label>
            <input
              value={form.taxId}
              onChange={e => setForm({ ...form, taxId: e.target.value })}
              className={inputCls}
            />
          </div>

          <div className="col-span-2">
            <label className={labelCls}>Notas</label>
            <textarea
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              className={cn(inputCls, 'h-20 py-2')}
            />
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
            <Button type="submit" disabled={pending}>
              {pending ? 'Guardando…' : 'Guardar proveedor'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
