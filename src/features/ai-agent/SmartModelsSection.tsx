'use client';

import type { SmartStockSettings } from '@/actions/smart-stock';
import { LockIcon, SparklesIcon } from 'lucide-react';
import { useState, useTransition } from 'react';
import { setSmartStockEnabled } from '@/actions/smart-stock';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Toaster } from '@/components/ui/toast';
import { toast } from '@/components/ui/toast-store';
import { Link } from '@/libs/I18nNavigation';

// "Modelos Inteligentes" — control room for deterministic models. Always
// rendered: Pro orgs can toggle Smart Stock; everyone else sees it locked as an
// upsell so they know it exists. The Inventory view only READS the flag.
export function SmartModelsSection({
  initialSettings,
}: {
  initialSettings: SmartStockSettings;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [pending, startTransition] = useTransition();
  const isPro = settings.isPro;

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
          <div className="flex items-center gap-2 font-medium">
            Smart Stock
            {!isPro && (
              <Badge variant="secondary" className="gap-1">
                <LockIcon className="size-3" />
                Pro
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Calcula y mantiene el stock mínimo de cada producto según tu
            velocidad de venta. Cuando está activo, la columna “Min” del
            inventario queda en modo IA (solo lectura).
          </p>
          {!isPro && (
            <Link
              href="/dashboard/plans"
              className="
                inline-flex pt-1 text-sm font-medium text-brand
                hover:underline
              "
            >
              Mejorá a Pro para activarlo →
            </Link>
          )}
        </div>
        <Switch
          checked={settings.enabled}
          disabled={pending || !isPro}
          onCheckedChange={toggle}
          aria-label="Activar Smart Stock"
        />
      </div>
    </section>
  );
}
