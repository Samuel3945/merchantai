'use client';

import type { OrgAddress } from '@/actions/org-addresses';
import { useState } from 'react';
import { createOrgAddress, updateOrgAddress } from '@/actions/org-addresses';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-xs font-medium text-muted-foreground';

const NEW = '__new__';

function addressLabel(a: OrgAddress): string {
  const place = [a.address, a.city].filter(Boolean).join(', ');
  return a.name ? `${a.name} — ${place}` : place;
}

type Mode = 'idle' | 'new' | 'edit';

/**
 * Branch-address picker for a caja. Lets the admin select an existing address,
 * create a new one, or edit the selected one. Reusable across the create modal
 * and the per-caja address modal. It owns the create/update server calls and
 * lifts the refreshed list back to the parent via `onAddressesChange`.
 */
export function AddressPicker({
  addresses,
  selectedId,
  onSelect,
  onAddressesChange,
  allowEdit = false,
}: {
  addresses: OrgAddress[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAddressesChange: (next: OrgAddress[]) => void;
  allowEdit?: boolean;
}) {
  const [mode, setMode] = useState<Mode>('idle');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = addresses.find(a => a.id === selectedId) ?? null;

  const options = [
    { value: '', label: '— Sin dirección —' },
    ...addresses.map(a => ({ value: a.id, label: addressLabel(a) })),
    { value: NEW, label: '➕ Crear nueva dirección' },
  ];

  const handleSelect = (value: string) => {
    setErr(null);
    if (value === NEW) {
      setName('');
      setAddress('');
      setCity('');
      setMode('new');
      return;
    }
    setMode('idle');
    onSelect(value || null);
  };

  const startEdit = () => {
    if (!selected) {
      return;
    }
    setName(selected.name ?? '');
    setAddress(selected.address);
    setCity(selected.city ?? '');
    setErr(null);
    setMode('edit');
  };

  const save = async () => {
    if (!address.trim()) {
      setErr('La dirección es obligatoria');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const payload = { name: name.trim() || null, address: address.trim(), city: city.trim() || null };
      if (mode === 'new') {
        const result = await createOrgAddress(payload);
        if (!result.ok) {
          setErr(result.error);
          return;
        }
        onAddressesChange([result.data, ...addresses]);
        onSelect(result.data.id);
      } else if (mode === 'edit' && selected) {
        const result = await updateOrgAddress(selected.id, payload);
        if (!result.ok) {
          setErr(result.error);
          return;
        }
        onAddressesChange(addresses.map(a => (a.id === result.data.id ? result.data : a)));
      }
      setMode('idle');
    } catch {
      setErr('No se pudo guardar la dirección');
    } finally {
      setBusy(false);
    }
  };

  const selectValue = mode === 'new' ? NEW : (selectedId ?? '');

  return (
    <div className="space-y-2">
      <Select
        id="caja-address"
        value={selectValue}
        onValueChange={handleSelect}
        options={options}
      />

      {allowEdit && mode === 'idle' && selected && (
        <button
          type="button"
          onClick={startEdit}
          className="
            text-xs font-medium text-primary
            hover:underline
          "
        >
          Editar esta dirección
        </button>
      )}

      {(mode === 'new' || mode === 'edit') && (
        <div className="
          space-y-2 rounded-md border border-input bg-muted/30 p-3
        "
        >
          <div>
            <label htmlFor="addr-name" className={labelCls}>
              Nombre de la sucursal (opcional)
            </label>
            <input
              id="addr-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Centro, Norte…"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="addr-address" className={labelCls}>
              Dirección
              {' '}
              <span className="text-destructive">*</span>
            </label>
            <input
              id="addr-address"
              type="text"
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="Calle 10 #20-30"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="addr-city" className={labelCls}>
              Ciudad
            </label>
            <input
              id="addr-city"
              type="text"
              value={city}
              onChange={e => setCity(e.target.value)}
              placeholder="Medellín"
              className={inputCls}
            />
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setMode('idle');
                setErr(null);
              }}
              disabled={busy}
            >
              Cancelar
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar dirección'}
            </Button>
          </div>
        </div>
      )}

      {err && mode === 'idle' && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
