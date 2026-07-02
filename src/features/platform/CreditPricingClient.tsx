'use client';

import type { ActionResult } from '@/libs/action-result';
import type { TopUpPackage } from '@/libs/topup-catalog';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setTopUpPackages } from '@/actions/topup-packages';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';

const copFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const inputClass
  = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

type PackageRow = {
  id: string;
  requests: string;
  amountCop: string;
};

function rowsFromPackages(packages: TopUpPackage[]): PackageRow[] {
  return packages.map(p => ({
    id: p.id,
    requests: String(p.requests),
    amountCop: String(p.amountCop),
  }));
}

export function CreditPricingClient(props: { packages: TopUpPackage[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<PackageRow[]>(() =>
    rowsFromPackages(props.packages));

  const run = (fn: () => Promise<ActionResult<TopUpPackage[]>>) => {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success('Cambios guardados');
        setRows(rowsFromPackages(result.data));
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const updateRow = (id: string, patch: Partial<PackageRow>) => {
    setRows(prev => prev.map(row => (row.id === id ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    setRows(prev => [
      ...prev,
      { id: crypto.randomUUID(), requests: '', amountCop: '' },
    ]);
  };

  const removeRow = (id: string) => {
    setRows(prev => prev.filter(row => row.id !== id));
  };

  const handleSave = () => {
    if (rows.length === 0) {
      toast.error('Debe existir al menos un paquete de créditos');
      return;
    }

    const parsed: { requests: number; amountCop: number }[] = [];
    for (const row of rows) {
      const requests = Number(row.requests);
      const amountCop = Number(row.amountCop);
      if (!Number.isInteger(requests) || requests <= 0) {
        toast.error('Las consultas deben ser un entero mayor a 0');
        return;
      }
      if (!Number.isFinite(amountCop) || amountCop < 0) {
        toast.error('El precio debe ser un número mayor o igual a 0');
        return;
      }
      parsed.push({ requests, amountCop });
    }

    run(() => setTopUpPackages(parsed));
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Precios de recargas de créditos</h1>
        <p className="text-sm text-muted-foreground">
          Paquetes de créditos de IA que los negocios pueden comprar desde su
          panel. Los cambios aplican de inmediato.
        </p>
      </div>

      <div className="space-y-3 rounded-xl border bg-card p-4">
        {rows.map((row) => {
          const requests = Number(row.requests);
          const amountCop = Number(row.amountCop);
          const unitPrice
            = requests > 0 && Number.isFinite(amountCop)
              ? amountCop / requests
              : null;

          return (
            <div key={row.id} className="flex items-end gap-3">
              <div className="flex-1">
                <label
                  htmlFor={`requests-${row.id}`}
                  className="text-xs font-medium"
                >
                  Consultas
                </label>
                <input
                  id={`requests-${row.id}`}
                  type="number"
                  min={1}
                  className={inputClass}
                  value={row.requests}
                  disabled={pending}
                  onChange={e => updateRow(row.id, { requests: e.target.value })}
                />
              </div>
              <div className="flex-1">
                <label
                  htmlFor={`amount-${row.id}`}
                  className="text-xs font-medium"
                >
                  Precio (COP)
                </label>
                <input
                  id={`amount-${row.id}`}
                  type="number"
                  min={0}
                  className={inputClass}
                  value={row.amountCop}
                  disabled={pending}
                  onChange={e => updateRow(row.id, { amountCop: e.target.value })}
                />
              </div>
              <div className="w-32 pb-2 text-xs text-muted-foreground">
                {unitPrice !== null
                  ? `${copFmt.format(unitPrice)} / consulta`
                  : '—'}
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => removeRow(row.id)}
              >
                Quitar
              </Button>
            </div>
          );
        })}

        <div className="flex items-center justify-between border-t pt-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={addRow}
          >
            Agregar paquete
          </Button>
          <Button disabled={pending} onClick={handleSave}>
            Guardar
          </Button>
        </div>
      </div>
    </div>
  );
}
