'use client';

import type { SupplierOption } from '@/features/suppliers/actions';
import { PlusIcon } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast-store';
import { createSupplier, listSuppliersForSelect } from '@/features/suppliers/actions';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

// Real supplier picker with inline quick-create. Replaces the old free-text
// input so entries store a supplier id (resolved to a name when displayed).
export function SupplierSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    listSuppliersForSelect()
      .then((rows) => {
        if (active) {
          setSuppliers(rows);
        }
      })
      .catch(() => {
        // non-fatal: the field stays empty and the user can still skip it
      });
    return () => {
      active = false;
    };
  }, []);

  function saveNew() {
    const name = newName.trim();
    if (!name) {
      return;
    }
    startTransition(async () => {
      try {
        const created = await createSupplier({
          name,
          phone: newPhone.trim() || null,
        });
        setSuppliers(prev =>
          [...prev, { id: created.id, name: created.name, company: created.company }]
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        onChange(created.id);
        setCreating(false);
        setNewName('');
        setNewPhone('');
        toast.success(`Proveedor "${created.name}" creado`);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'No se pudo crear el proveedor',
        );
      }
    });
  }

  if (creating) {
    return (
      <div className="space-y-2 rounded-md border border-dashed p-3">
        <input
          autoFocus
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="Nombre del proveedor"
          className={inputCls}
        />
        <input
          value={newPhone}
          onChange={e => setNewPhone(e.target.value)}
          placeholder="Teléfono (opcional)"
          className={inputCls}
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setCreating(false)}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={saveNew}
            disabled={pending || !newName.trim()}
          >
            {pending ? 'Guardando...' : 'Guardar proveedor'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <Select
        value={value}
        onValueChange={onChange}
        className="flex-1"
        options={[
          { value: '', label: 'Sin proveedor' },
          ...suppliers.map(s => ({
            value: s.id,
            label: `${s.name}${s.company ? ` · ${s.company}` : ''}`,
          })),
        ]}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setCreating(true)}
        aria-label="Nuevo proveedor"
      >
        <PlusIcon className="size-4" />
      </Button>
    </div>
  );
}
