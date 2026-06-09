'use client';

import type { SmartStockSettings } from '@/actions/smart-stock';
import { SparklesIcon } from 'lucide-react';
import { useState, useTransition } from 'react';
import { setSmartStockEnabled } from '@/actions/smart-stock';
import { Switch } from '@/components/ui/switch';
import { Toaster } from '@/components/ui/toast';
import { toast } from '@/components/ui/toast-store';

// "Modelos Inteligentes" — the Pro-only control room for deterministic models.
// Today it hosts the Smart Stock toggle; turning it on recomputes every
// product's minimum from sales velocity. The Inventory view only READS this
// flag — it never flips it.
export function SmartModelsSection({
  initialSettings,
}: {
  initialSettings: SmartStockSettings;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [pending, startTransition] = useTransition();

  function toggle(next: boolean) {
    startTransition(async () => {
      try {
        const updated = await setSmartStockEnabled(next);
        setSettings(updated);
        toast.success(
          next
            ? 'Smart Stock activado — mínimos recalculados por IA'
            : 'Smart Stock desactivado — mínimos vuelven a manual',
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'No se pudo actualizar');
      }
    });
  }

  return (
    <section className="mt-8 space-y-4">
      <Toaster />
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <SparklesIcon className="size-5 text-brand" />
          Modelos Inteligentes
        </h2>
        <p className="text-sm text-muted-foreground">
          Modelos deterministas que automatizan decisiones de tu negocio.
        </p>
      </div>

      <div className="
        flex items-start justify-between rounded-md border bg-background p-4
      "
      >
        <div className="space-y-1 pr-4">
          <div className="font-medium">Smart Stock</div>
          <p className="text-sm text-muted-foreground">
            Calcula y mantiene el stock mínimo de cada producto según tu
            velocidad de venta. Cuando está activo, la columna “Min” del
            inventario queda en modo IA (solo lectura).
          </p>
        </div>
        <Switch
          checked={settings.enabled}
          disabled={pending}
          onCheckedChange={toggle}
          aria-label="Activar Smart Stock"
        />
      </div>
    </section>
  );
}
