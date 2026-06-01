'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setAppSetting } from '@/actions/app-settings';
import { upgradePlan } from '@/actions/plans';
import { Button } from '@/components/ui/button';

type BusinessType = 'tienda' | 'restaurante' | 'farmacia';

type PaymentMethod
  = | 'efectivo'
    | 'nequi'
    | 'daviplata'
    | 'tarjeta'
    | 'fiado'
    | 'transferencia';

type Plan = 'free' | 'pro' | 'business';

const BUSINESS_TYPES: { value: BusinessType; label: string }[] = [
  { value: 'tienda', label: 'Tienda' },
  { value: 'restaurante', label: 'Restaurante' },
  { value: 'farmacia', label: 'Farmacia' },
];

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'nequi', label: 'Nequi' },
  { value: 'daviplata', label: 'Daviplata' },
  { value: 'tarjeta', label: 'Tarjeta' },
  { value: 'fiado', label: 'Fiado' },
  { value: 'transferencia', label: 'Transferencia' },
];

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
  'Tipo de negocio',
  'Métodos de pago',
  'Plan',
];

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
          done
            ? 'bg-primary text-primary-foreground'
            : active
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
                ${
          active ? 'font-medium' : 'text-muted-foreground'
          }
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
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [businessName, setBusinessName] = useState('');
  const [businessAddress, setBusinessAddress] = useState('');
  const [businessPhone, setBusinessPhone] = useState('');
  const [businessType, setBusinessType] = useState<BusinessType>('tienda');
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([
    'efectivo',
  ]);
  const [plan, setPlan] = useState<Plan>('free');

  const togglePayment = (m: PaymentMethod) => {
    setPaymentMethods(prev =>
      prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m],
    );
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
          await setAppSetting('business_name', businessName.trim());
          await setAppSetting('business_address', businessAddress.trim());
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
          await setAppSetting('business_type', businessType);
          setStep(2);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Error inesperado');
        }
      });
      return;
    }

    if (step === 2) {
      if (paymentMethods.length === 0) {
        setError('Selecciona al menos un método de pago.');
        return;
      }
      startTransition(async () => {
        try {
          await setAppSetting(
            'payment_methods',
            JSON.stringify(paymentMethods),
          );
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
          router.replace('/dashboard');
          return;
        }
        await upgradePlan(plan);
        await setAppSetting('onboarding_completed', 'true');
        window.location.href = wompiCheckoutUrl(plan);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  };

  const handleBack = () => {
    setError(null);
    setStep(s => Math.max(0, s - 1));
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
              className="
                mt-1 w-full rounded-md border border-input bg-background px-3
                py-2 text-sm
                focus:ring-2 focus:ring-ring focus:outline-none
              "
              value={businessName}
              onChange={e => setBusinessName(e.target.value)}
              placeholder="Tienda Doña Marta"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Dirección</span>
            <input
              type="text"
              className="
                mt-1 w-full rounded-md border border-input bg-background px-3
                py-2 text-sm
                focus:ring-2 focus:ring-ring focus:outline-none
              "
              value={businessAddress}
              onChange={e => setBusinessAddress(e.target.value)}
              placeholder="Calle 10 #20-30, Medellín"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Teléfono</span>
            <input
              type="tel"
              className="
                mt-1 w-full rounded-md border border-input bg-background px-3
                py-2 text-sm
                focus:ring-2 focus:ring-ring focus:outline-none
              "
              value={businessPhone}
              onChange={e => setBusinessPhone(e.target.value)}
              placeholder="3001234567"
            />
          </label>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-2">
          {BUSINESS_TYPES.map(t => (
            <label
              key={t.value}
              className={`
                flex cursor-pointer items-center gap-3 rounded-lg border px-4
                py-3
                ${
            businessType === t.value
              ? 'border-primary bg-muted/50'
              : 'border-border'
            }
              `}
            >
              <input
                type="radio"
                name="business-type"
                value={t.value}
                checked={businessType === t.value}
                onChange={() => setBusinessType(t.value)}
              />
              <span className="font-medium">{t.label}</span>
            </label>
          ))}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-2">
          {PAYMENT_METHODS.map(m => (
            <label
              key={m.value}
              className={`
                flex cursor-pointer items-center gap-3 rounded-lg border px-4
                py-3
                ${
            paymentMethods.includes(m.value)
              ? 'border-primary bg-muted/50'
              : 'border-border'
            }
              `}
            >
              <input
                type="checkbox"
                checked={paymentMethods.includes(m.value)}
                onChange={() => togglePayment(m.value)}
              />
              <span className="font-medium">{m.label}</span>
            </label>
          ))}
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
              : `border-border`
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
