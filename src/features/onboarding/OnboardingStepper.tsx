'use client';

import { useOrganization, useOrganizationList } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { setAppSetting } from '@/actions/app-settings';
import { createPaymentMethod } from '@/actions/payment-methods';
import { upgradePlan } from '@/actions/plans';
import { Button } from '@/components/ui/button';

type Plan = 'free' | 'pro' | 'business';

type FeatureFlags = {
  sellByWeight: boolean;
  wholesale: boolean;
  perishable: boolean;
};

// A transfer account the merchant adds during onboarding. Persisted immediately
// via createPaymentMethod so the data lives in the same place as Settings.
type TransferAccount = {
  id: string;
  name: string;
  summary: string;
};

const PLANS: { value: Plan; title: string; price: string; description: string }[] = [
  {
    value: 'free',
    title: 'Gratis',
    price: 'COP 0 / mes',
    description: 'POS y gestión básica, sin agentes de IA.',
  },
  {
    value: 'pro',
    title: 'Pro',
    price: 'COP 89.000 / mes',
    description: 'Sales Manager: 500 consultas/mes + reportes avanzados.',
  },
  {
    value: 'business',
    title: 'Business',
    price: 'COP 199.000 / mes',
    description: 'Sales Manager + Customer Service y soporte prioritario.',
  },
];

// Wompi checkout entrypoint. Replace NEXT_PUBLIC_WOMPI_CHECKOUT_URL with a
// real per-plan payment link once the integration is provisioned.
function wompiCheckoutUrl(plan: Plan): string {
  const base
    = process.env.NEXT_PUBLIC_WOMPI_CHECKOUT_URL ?? 'https://checkout.wompi.co/';
  const url = new URL(base);
  url.searchParams.set('plan', plan);
  return url.toString();
}

const STEP_TITLES = [
  'Datos del negocio',
  'Tu negocio',
  'Cobros',
  'Plan',
];

const inputCls
  = 'mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring focus:outline-none';

function Stepper({ step }: { step: number }) {
  return (
    <div className="mb-8 flex items-center justify-between">
      {STEP_TITLES.map((title, i) => {
        const active = i === step;
        const done = i < step;
        return (
          <div key={title} className="flex flex-1 items-center">
            <div
              className={`
                flex size-8 items-center justify-center rounded-full text-sm
                font-semibold
                ${
          done || active
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted-foreground/20 text-muted-foreground'
          }
              `}
            >
              {i + 1}
            </div>
            <span
              className={`
                ml-2 hidden text-sm
                sm:inline
                ${active ? 'font-medium' : 'text-muted-foreground'}
              `}
            >
              {title}
            </span>
            {i < STEP_TITLES.length - 1 && (
              <div className="mx-3 h-px flex-1 bg-muted-foreground/20" />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function OnboardingStepper() {
  const router = useRouter();
  const { organization } = useOrganization();
  const { isLoaded: orgListLoaded, setActive, createOrganization, userMemberships }
    = useOrganizationList({ userMemberships: { infinite: true } });

  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Step 0 — business identity + contact.
  const [businessName, setBusinessName] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string>('');
  const [businessPhone, setBusinessPhone] = useState('');

  // Step 1 — sale modalities (the adaptive logic; replaces "tipo de negocio").
  const [features, setFeatures] = useState<FeatureFlags>({
    sellByWeight: false,
    wholesale: false,
    perishable: false,
  });

  // Step 2 — collections.
  const [creditoEnabled, setCreditoEnabled] = useState(true);
  const [transfers, setTransfers] = useState<TransferAccount[]>([]);
  const [showAddTransfer, setShowAddTransfer] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftBank, setDraftBank] = useState('');
  const [draftAccount, setDraftAccount] = useState('');
  const [draftHolder, setDraftHolder] = useState('');
  const [addingTransfer, setAddingTransfer] = useState(false);

  // Step 3 — plan + AI agent.
  const [plan, setPlan] = useState<Plan>('free');
  const [aiOptIn, setAiOptIn] = useState(false);

  // Guards a single org creation across retries — never create two orgs if the
  // first persist call races the session update and the user clicks again.
  const orgReadyRef = useRef(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handlePickLogo = (file: File | undefined) => {
    if (!file) {
      return;
    }
    setLogoFile(file);
    setLogoPreview((prev) => {
      if (prev) {
        URL.revokeObjectURL(prev);
      }
      return URL.createObjectURL(file);
    });
  };

  // Upload the logo only after the org exists (the endpoint is org-scoped).
  const uploadLogo = async (): Promise<string | null> => {
    if (!logoFile) {
      return null;
    }
    const fd = new FormData();
    fd.append('file', logoFile);
    const res = await fetch('/api/upload/logo', { method: 'POST', body: fd });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `No se pudo subir el logo (${res.status})`);
    }
    const data = (await res.json()) as { url: string };
    return data.url;
  };

  // Ensure there is an active organization before we touch org-scoped settings.
  // Brand-new merchants create one (name + optional logo). A returning user who
  // somehow lost their active org just re-activates the existing one.
  const ensureOrg = async (): Promise<'created' | 'reactivated'> => {
    if (organization || orgReadyRef.current) {
      return 'created';
    }
    if (!orgListLoaded || !setActive || !createOrganization) {
      throw new Error('Cargando tu sesión, intenta de nuevo en un momento.');
    }

    const existing = userMemberships?.data?.[0];
    if (existing) {
      await setActive({ organization: existing.organization.id });
      orgReadyRef.current = true;
      return 'reactivated';
    }

    const org = await createOrganization({ name: businessName.trim() });
    await setActive({ organization: org.id });
    orgReadyRef.current = true;
    return 'created';
  };

  const handleNext = () => {
    setError(null);

    if (step === 0) {
      if (!businessName.trim()) {
        setError('Ingresa el nombre del negocio.');
        return;
      }
      startTransition(async () => {
        try {
          const outcome = await ensureOrg();
          // Returning user with an existing business — let the dashboard gate
          // decide where they belong instead of re-running onboarding here.
          if (outcome === 'reactivated') {
            router.replace('/dashboard');
            return;
          }
          const logoUrl = await uploadLogo();
          await setAppSetting('business_name', businessName.trim());
          if (logoUrl) {
            await setAppSetting('business_logo', logoUrl);
          }
          await setAppSetting('business_phone', businessPhone.trim());
          setStep(1);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Error inesperado');
        }
      });
      return;
    }

    if (step === 1) {
      startTransition(async () => {
        try {
          await setAppSetting(
            'features.sell_by_weight',
            features.sellByWeight ? 'true' : 'false',
          );
          await setAppSetting(
            'features.wholesale',
            features.wholesale ? 'true' : 'false',
          );
          await setAppSetting(
            'features.perishable',
            features.perishable ? 'true' : 'false',
          );
          setStep(2);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Error inesperado');
        }
      });
      return;
    }

    if (step === 2) {
      startTransition(async () => {
        try {
          await setAppSetting('credito-enabled', creditoEnabled ? 'true' : 'false');
          setStep(3);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Error inesperado');
        }
      });
      return;
    }

    // Step 3 — plan selection + finalize.
    startTransition(async () => {
      try {
        if (plan === 'free') {
          await setAppSetting('onboarding_completed', 'true');
          router.replace(aiOptIn ? '/dashboard/ai-agent' : '/dashboard');
          return;
        }
        await upgradePlan(plan);
        await setAppSetting('onboarding_completed', 'true');
        // Paid plans go through Wompi checkout. Carry the AI intent so the
        // post-checkout landing can route straight to the agent setup.
        const url = new URL(wompiCheckoutUrl(plan));
        if (aiOptIn) {
          url.searchParams.set('next', '/dashboard/ai-agent');
        }
        window.location.href = url.toString();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  };

  const handleBack = () => {
    setError(null);
    setStep(s => Math.max(0, s - 1));
  };

  const handleAddTransfer = () => {
    setError(null);
    if (!draftName.trim()) {
      setError('Ponle un nombre a la cuenta (ej: Nequi).');
      return;
    }
    setAddingTransfer(true);
    startTransition(async () => {
      try {
        const details = Object.fromEntries(
          Object.entries({
            bank: draftBank.trim(),
            account_number: draftAccount.trim(),
            holder_name: draftHolder.trim(),
          }).filter(([, v]) => v !== ''),
        );
        const row = await createPaymentMethod({
          name: draftName.trim(),
          type: 'transfer',
          sortOrder: transfers.length,
          details,
        });
        const summary = [draftBank, draftAccount, draftHolder]
          .map(v => v.trim())
          .filter(Boolean)
          .join(' · ');
        setTransfers(prev => [...prev, { id: row.id, name: row.name, summary }]);
        setDraftName('');
        setDraftBank('');
        setDraftAccount('');
        setDraftHolder('');
        setShowAddTransfer(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo agregar la cuenta');
      } finally {
        setAddingTransfer(false);
      }
    });
  };

  return (
    <div className="rounded-xl border border-border bg-background p-6 shadow-sm">
      <h1 className="text-2xl font-semibold">Configura tu negocio</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Solo te tomará un minuto. Podrás editar todo desde Ajustes después.
      </p>

      <div className="mt-6">
        <Stepper step={step} />
      </div>

      {error && (
        <div className="
          mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4
          py-3 text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      {step === 0 && (
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Nombre del negocio</span>
            <input
              type="text"
              className={inputCls}
              value={businessName}
              onChange={e => setBusinessName(e.target.value)}
              placeholder="Tienda Doña Marta"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              Así se llamará tu organización. Aparece en tickets y facturas.
            </span>
          </label>

          <div>
            <span className="text-sm font-medium">Logo (opcional)</span>
            <div className="mt-1 flex items-center gap-3">
              <div className="
                flex size-16 items-center justify-center overflow-hidden
                rounded-md border border-border bg-muted
              "
              >
                {logoPreview
                  ? (
                      // eslint-disable-next-line next/no-img-element
                      <img
                        src={logoPreview}
                        alt="Logo"
                        className="size-full object-contain"
                      />
                    )
                  : (
                      <span className="text-xs text-muted-foreground">Sin logo</span>
                    )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={e => handlePickLogo(e.target.files?.[0])}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="
                  h-9 rounded-md border border-input bg-background px-3 text-sm
                  font-medium
                  hover:bg-muted
                "
              >
                {logoFile ? 'Cambiar logo' : 'Subir logo'}
              </button>
            </div>
            <span className="mt-1 block text-xs text-muted-foreground">
              Puedes ponerlo ahora o más tarde desde Ajustes.
            </span>
          </div>

          <label className="block">
            <span className="text-sm font-medium">Teléfono</span>
            <input
              type="tel"
              className={inputCls}
              value={businessPhone}
              onChange={e => setBusinessPhone(e.target.value)}
              placeholder="3001234567"
            />
          </label>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Cuéntanos cómo vendes. Esto adapta el sistema a tu negocio: solo verás
            lo que de verdad usas. Puedes cambiarlo cuando quieras en Ajustes.
          </p>
          <FeatureToggle
            label="Vendo por peso (Kg)"
            description="Frutas, carnes, granel: productos que se cobran por kilo."
            checked={features.sellByWeight}
            onChange={v => setFeatures(f => ({ ...f, sellByWeight: v }))}
          />
          <FeatureToggle
            label="Vendo al por mayor"
            description="Precios escalonados por cantidad (descuentos por volumen)."
            checked={features.wholesale}
            onChange={v => setFeatures(f => ({ ...f, wholesale: v }))}
          />
          <FeatureToggle
            label="Manejo productos perecederos"
            description="Lácteos, carnes, panadería: controla vencimiento por lote."
            checked={features.perishable}
            onChange={v => setFeatures(f => ({ ...f, perishable: v }))}
          />
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            El efectivo siempre está disponible. Activa el crédito y agrega tus
            cuentas de transferencia para que el bot las comparta con el cliente.
          </p>

          <div className="
            flex items-center justify-between rounded-md border border-border
            bg-muted/30 px-4 py-3
          "
          >
            <div>
              <div className="text-sm font-medium">Efectivo</div>
              <div className="text-xs text-muted-foreground">Siempre activo</div>
            </div>
            <span className="
              rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold
              text-primary
            "
            >
              Incluido
            </span>
          </div>

          <FeatureToggle
            label="Crédito"
            description="Permite registrar ventas a crédito con saldo pendiente."
            checked={creditoEnabled}
            onChange={setCreditoEnabled}
          />

          <div className="border-t pt-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Cuentas de transferencia</span>
              {!showAddTransfer && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowAddTransfer(true)}
                  disabled={pending}
                >
                  Agregar cuenta
                </Button>
              )}
            </div>

            {transfers.length > 0 && (
              <ul className="mt-3 space-y-2">
                {transfers.map(t => (
                  <li
                    key={t.id}
                    className="
                      rounded-md border border-border bg-background px-3 py-2
                      text-sm
                    "
                  >
                    <div className="font-medium">{t.name}</div>
                    {t.summary && (
                      <div className="text-xs text-muted-foreground">
                        {t.summary}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {showAddTransfer && (
              <div className="
                mt-3 space-y-3 rounded-md border border-border bg-muted/30 p-3
              "
              >
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground">
                    Nombre de la cuenta
                  </span>
                  <input
                    type="text"
                    className={inputCls}
                    value={draftName}
                    onChange={e => setDraftName(e.target.value)}
                    placeholder="Nequi"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground">
                    Banco o billetera
                  </span>
                  <input
                    type="text"
                    className={inputCls}
                    value={draftBank}
                    onChange={e => setDraftBank(e.target.value)}
                    placeholder="Bancolombia, Nequi, Daviplata…"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground">
                    Número de cuenta o celular
                  </span>
                  <input
                    type="text"
                    className={inputCls}
                    value={draftAccount}
                    onChange={e => setDraftAccount(e.target.value)}
                    placeholder="Ej: 300 123 4567"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground">
                    A nombre de
                  </span>
                  <input
                    type="text"
                    className={inputCls}
                    value={draftHolder}
                    onChange={e => setDraftHolder(e.target.value)}
                    placeholder="Ej: Juan García"
                  />
                </label>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowAddTransfer(false);
                      setError(null);
                    }}
                    disabled={addingTransfer}
                  >
                    Cancelar
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleAddTransfer}
                    disabled={addingTransfer}
                  >
                    {addingTransfer ? 'Guardando…' : 'Guardar cuenta'}
                  </Button>
                </div>
              </div>
            )}

            {transfers.length === 0 && !showAddTransfer && (
              <p className="mt-2 text-xs text-muted-foreground">
                Opcional. También puedes agregarlas después desde Ajustes.
              </p>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          {PLANS.map(p => (
            <label
              key={p.value}
              className={`
                flex cursor-pointer items-start gap-3 rounded-lg border px-4
                py-3
                ${
            plan === p.value
              ? 'border-primary bg-muted/50'
              : 'border-border'
            }
              `}
            >
              <input
                type="radio"
                name="plan"
                value={p.value}
                checked={plan === p.value}
                onChange={() => setPlan(p.value)}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{p.title}</span>
                  <span className="text-sm text-muted-foreground">{p.price}</span>
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {p.description}
                </div>
              </div>
            </label>
          ))}

          <div className="
            mt-2 flex items-start gap-3 rounded-lg border border-border px-4
            py-3
          "
          >
            <input
              id="ai-optin"
              type="checkbox"
              checked={aiOptIn}
              onChange={e => setAiOptIn(e.target.checked)}
              className="mt-1"
            />
            <label htmlFor="ai-optin" className="flex-1 cursor-pointer">
              <span className="font-medium">Configurar el Agente IA al terminar</span>
              <span className="mt-1 block text-sm text-muted-foreground">
                Te llevamos directo a conectar tu agente (personalidad, canales y
                ventas por chat).
                {plan === 'free' && ' Las consultas de IA requieren un plan Pro.'}
              </span>
            </label>
          </div>

          {plan !== 'free' && (
            <p className="text-xs text-muted-foreground">
              Al continuar, te enviaremos al checkout de Wompi para confirmar el
              pago.
            </p>
          )}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={handleBack}
          disabled={step === 0 || pending}
        >
          Atrás
        </Button>
        <Button onClick={handleNext} disabled={pending}>
          {pending
            ? 'Guardando…'
            : step === STEP_TITLES.length - 1
              ? plan === 'free'
                ? 'Finalizar'
                : 'Ir a pagar'
              : 'Siguiente'}
        </Button>
      </div>
    </div>
  );
}

function FeatureToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={`
        flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3
        ${checked ? 'border-primary bg-muted/50' : 'border-border'}
      `}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-1"
      />
      <div className="flex-1">
        <span className="font-medium">{label}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">
          {description}
        </span>
      </div>
    </label>
  );
}
