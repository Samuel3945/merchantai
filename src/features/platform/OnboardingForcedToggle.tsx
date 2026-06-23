'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setOnboardingForced } from '@/actions/platform-orgs';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast-store';

export function OnboardingForcedToggle(props: { initialEnabled: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(props.initialEnabled);
  const [pending, startTransition] = useTransition();

  const onToggle = (next: boolean) => {
    setEnabled(next); // optimistic
    startTransition(async () => {
      const result = await setOnboardingForced(next);
      if (result.ok) {
        toast.success(
          next ? 'Onboarding forzado activado' : 'Onboarding desactivado',
        );
        router.refresh();
      } else {
        setEnabled(!next); // revert on failure
        toast.error(result.error ?? 'Error inesperado');
      }
    });
  };

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Onboarding forzado</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Activo: cada nuevo dueño debe completar el asistente antes de entrar
            al panel. Apagado (por defecto): vos configurás los negocios en
            Ajustes y solo el operador puede abrir el asistente para probarlo.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={pending}
          onCheckedChange={onToggle}
          aria-label="Forzar onboarding"
        />
      </div>
    </div>
  );
}
