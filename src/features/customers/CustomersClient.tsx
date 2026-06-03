'use client';

import type { CustomerListItem } from './actions';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import {
  createCustomer,

  listCustomers,
  softDeleteCustomer,
  updateCustomer,
} from './actions';

type CustomerFormState = {
  name: string;
  documentId: string;
  whatsapp: string;
  email: string;
  address: string;
  notes: string;
  marketingOptIn: boolean;
};

const emptyForm: CustomerFormState = {
  name: '',
  documentId: '',
  whatsapp: '',
  email: '',
  address: '',
  notes: '',
  marketingOptIn: true,
};

function toFormState(c: CustomerListItem): CustomerFormState {
  return {
    name: c.name,
    documentId: c.documentId ?? '',
    whatsapp: c.whatsapp ?? '',
    email: c.email ?? '',
    address: c.address ?? '',
    notes: '',
    marketingOptIn: true,
  };
}

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const labelCls = 'text-sm font-medium';

function formatMoney(value: string | number) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) {
    return '0';
  }
  return n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

function formatDate(d: Date | string | null) {
  if (!d) {
    return '—';
  }
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleDateString('es-CO', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function CustomersClient({ initial }: { initial: CustomerListItem[] }) {
  const [rows, setRows] = useState<CustomerListItem[]>(initial);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerListItem | null>(null);
  const [form, setForm] = useState<CustomerFormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
    }
    searchTimer.current = setTimeout(() => {
      startTransition(async () => {
        const data = await listCustomers({ search });
        setRows(data);
      });
    }, 250);
    return () => {
      if (searchTimer.current) {
        clearTimeout(searchTimer.current);
      }
    };
  }, [search]);

  const totalSpentAgg = useMemo(
    () =>
      rows.reduce(
        (acc, r) => acc + (Number.parseFloat(r.totalSpent) || 0),
        0,
      ),
    [rows],
  );

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setOpen(true);
  }

  function openEdit(c: CustomerListItem) {
    setEditing(c);
    setForm(toFormState(c));
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
      name: form.name.trim(),
      documentId: form.documentId.trim() === '' ? null : form.documentId.trim(),
      whatsapp: form.whatsapp.trim() === '' ? null : form.whatsapp.trim(),
      email: form.email.trim() === '' ? null : form.email.trim(),
      address: form.address.trim() === '' ? null : form.address.trim(),
      notes: form.notes.trim() === '' ? null : form.notes.trim(),
      marketingOptIn: form.marketingOptIn,
    };

    startTransition(async () => {
      try {
        if (editing) {
          const updated = await updateCustomer(editing.id, payload);
          setRows(prev =>
            prev.map(r =>
              r.id === updated.id
                ? {
                    id: updated.id,
                    name: updated.name,
                    documentId: updated.documentId,
                    whatsapp: updated.whatsapp,
                    email: updated.email,
                    address: updated.address,
                    totalSpent: updated.totalSpent,
                    lastPurchaseAt: updated.lastPurchaseAt,
                  }
                : r,
            ),
          );
        } else {
          const created = await createCustomer(payload);
          setRows(prev =>
            [
              {
                id: created.id,
                name: created.name,
                documentId: created.documentId,
                whatsapp: created.whatsapp,
                email: created.email,
                address: created.address,
                totalSpent: created.totalSpent,
                lastPurchaseAt: created.lastPurchaseAt,
              },
              ...prev,
            ].sort((a, b) => a.name.localeCompare(b.name)),
          );
        }
        close();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  function onDelete(c: CustomerListItem) {
    // eslint-disable-next-line no-alert
    if (!globalThis.confirm(`Eliminar "${c.name}"?`)) {
      return;
    }
    startTransition(async () => {
      try {
        await softDeleteCustomer(c.id);
        setRows(prev => prev.filter(r => r.id !== c.id));
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
          placeholder="Buscar por nombre, documento, whatsapp o email"
          className={cn(inputCls, 'max-w-md')}
        />
        <Button onClick={openCreate}>Nuevo cliente</Button>
        <div className="ml-auto text-sm text-muted-foreground">
          {rows.length}
          {' '}
          clientes · gasto total $
          {formatMoney(totalSpentAgg)}
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Nombre</th>
              <th className="px-3 py-2">Documento</th>
              <th className="px-3 py-2">WhatsApp</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Dirección</th>
              <th className="px-3 py-2 text-right">Total gastado</th>
              <th className="px-3 py-2">Última compra</th>
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
                      {pending ? 'Cargando…' : 'Aún no hay clientes'}
                    </td>
                  </tr>
                )
              : (
                  rows.map(c => (
                    <tr key={c.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {c.documentId ?? '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {c.whatsapp ?? '—'}
                      </td>
                      <td className="px-3 py-2">{c.email ?? '—'}</td>
                      <td className="px-3 py-2">{c.address ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        $
                        {formatMoney(c.totalSpent)}
                      </td>
                      <td className="px-3 py-2">{formatDate(c.lastPurchaseAt)}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openEdit(c)}
                          >
                            Editar
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => onDelete(c)}
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
              w-full max-w-2xl rounded-lg border bg-background p-6 shadow-lg
            "
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {editing ? 'Editar cliente' : 'Nuevo cliente'}
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

            <form onSubmit={onSubmit} className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className={labelCls}>Nombre</label>
                <input
                  required
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>Documento (CC/NIT)</label>
                <input
                  value={form.documentId}
                  onChange={e =>
                    setForm({ ...form, documentId: e.target.value })}
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>WhatsApp</label>
                <input
                  inputMode="tel"
                  value={form.whatsapp}
                  onChange={e =>
                    setForm({ ...form, whatsapp: e.target.value })}
                  className={inputCls}
                />
              </div>

              <div className="col-span-2">
                <label className={labelCls}>Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
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
                <label className={labelCls}>Notas</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm({ ...form, notes: e.target.value })}
                  className={cn(inputCls, 'h-20 py-2')}
                />
              </div>

              <label className="col-span-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.marketingOptIn}
                  onChange={e =>
                    setForm({ ...form, marketingOptIn: e.target.checked })}
                />
                Acepta comunicaciones de marketing
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
                  Cancelar
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
