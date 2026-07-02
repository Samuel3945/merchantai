'use client';

import type { PlanFields, PlatformPlan } from '@/actions/platform-plans';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  createPlan,
  removePlanEntitlement,
  setDefaultPlan,
  setPlanArchived,
  setPlanEntitlement,
  updatePlan,
} from '@/actions/platform-plans';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast-store';

// Suggested entitlement keys; the operator can also type new ones.
const KNOWN_ENTITLEMENT_KEYS = [
  'max_cashiers',
  'max_pos_devices',
  'ai_credits',
  'ai_credits_sales_manager',
  'ai_credits_customer_service',
  'ai_credits_einvoice',
  'feature_smart_stock',
];

const copFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const inputClass
  = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

type PlanFormState = {
  slug: string;
  name: string;
  description: string;
  priceMonthlyCop: string;
  priceAnnualCop: string;
  bulletsText: string;
  isPublic: boolean;
  sortOrder: string;
};

function emptyForm(): PlanFormState {
  return {
    slug: '',
    name: '',
    description: '',
    priceMonthlyCop: '0',
    priceAnnualCop: '',
    bulletsText: '',
    isPublic: true,
    sortOrder: '0',
  };
}

function formFromPlan(plan: PlatformPlan): PlanFormState {
  return {
    slug: plan.slug,
    name: plan.name,
    description: plan.description ?? '',
    priceMonthlyCop: String(plan.priceMonthlyCop),
    priceAnnualCop:
      plan.priceAnnualCop === null ? '' : String(plan.priceAnnualCop),
    bulletsText: plan.featureBullets.join('\n'),
    isPublic: plan.isPublic,
    sortOrder: String(plan.sortOrder),
  };
}

function fieldsFromForm(form: PlanFormState): PlanFields {
  return {
    name: form.name,
    description: form.description,
    priceMonthlyCop: Number(form.priceMonthlyCop),
    priceAnnualCop:
      form.priceAnnualCop.trim() === '' ? null : Number(form.priceAnnualCop),
    featureBullets: form.bulletsText.split('\n'),
    isPublic: form.isPublic,
    sortOrder: Number(form.sortOrder),
  };
}

function PlanFormDialog(props: {
  open: boolean;
  title: string;
  form: PlanFormState;
  slugEditable: boolean;
  busy: boolean;
  onChange: (form: PlanFormState) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { form } = props;
  return (
    <Dialog open={props.open} onOpenChange={open => !open && props.onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="plan-slug" className="text-xs font-medium">
                Identificador (slug)
              </label>
              <input
                id="plan-slug"
                type="text"
                className={inputClass}
                value={form.slug}
                disabled={!props.slugEditable}
                placeholder="ej: premium"
                onChange={e =>
                  props.onChange({ ...form, slug: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="plan-name" className="text-xs font-medium">
                Nombre
              </label>
              <input
                id="plan-name"
                type="text"
                className={inputClass}
                value={form.name}
                placeholder="ej: Premium"
                onChange={e =>
                  props.onChange({ ...form, name: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label htmlFor="plan-desc" className="text-xs font-medium">
              Descripción
            </label>
            <input
              id="plan-desc"
              type="text"
              className={inputClass}
              value={form.description}
              onChange={e =>
                props.onChange({ ...form, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="plan-price-m" className="text-xs font-medium">
                Precio mensual (COP)
              </label>
              <input
                id="plan-price-m"
                type="number"
                min={0}
                className={inputClass}
                value={form.priceMonthlyCop}
                onChange={e =>
                  props.onChange({ ...form, priceMonthlyCop: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="plan-price-a" className="text-xs font-medium">
                Precio anual (COP)
              </label>
              <input
                id="plan-price-a"
                type="number"
                min={0}
                className={inputClass}
                value={form.priceAnnualCop}
                placeholder="Sin opción anual"
                onChange={e =>
                  props.onChange({ ...form, priceAnnualCop: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="plan-sort" className="text-xs font-medium">
                Orden
              </label>
              <input
                id="plan-sort"
                type="number"
                className={inputClass}
                value={form.sortOrder}
                onChange={e =>
                  props.onChange({ ...form, sortOrder: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label htmlFor="plan-bullets" className="text-xs font-medium">
              Beneficios visibles (uno por línea)
            </label>
            <textarea
              id="plan-bullets"
              rows={5}
              className={inputClass}
              value={form.bulletsText}
              onChange={e =>
                props.onChange({ ...form, bulletsText: e.target.value })}
            />
          </div>
          <div className="
            flex items-center justify-between rounded-md border p-3
          "
          >
            <div>
              <div className="text-sm font-medium">Visible para negocios</div>
              <div className="text-xs text-muted-foreground">
                Los planes ocultos solo se asignan desde esta consola.
              </div>
            </div>
            <Switch
              checked={form.isPublic}
              onCheckedChange={checked =>
                props.onChange({ ...form, isPublic: checked })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={props.onClose} disabled={props.busy}>
              Cancelar
            </Button>
            <Button onClick={props.onSubmit} disabled={props.busy}>
              Guardar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EntitlementsEditor(props: {
  plan: PlatformPlan;
  busy: boolean;
  onSet: (key: string, value: number) => void;
  onRemove: (key: string) => void;
}) {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('0');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const addNew = () => {
    const value = Number(newValue);
    if (!newKey.trim() || !Number.isInteger(value) || value < 0) {
      toast.error('Clave o valor inválido');
      return;
    }
    props.onSet(newKey.trim().toLowerCase(), value);
    setNewKey('');
    setNewValue('0');
  };

  return (
    <div className="mt-3 space-y-2">
      <div className="text-xs font-semibold text-muted-foreground uppercase">
        Permisos y límites
      </div>
      {props.plan.entitlements.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Sin permisos definidos: este plan hereda los valores de respaldo
          (equivalentes al plan gratis).
        </p>
      )}
      {props.plan.entitlements.map(ent => (
        <div key={ent.key} className="flex items-center gap-2">
          <code className="flex-1 truncate text-xs">{ent.key}</code>
          <input
            type="number"
            min={0}
            className="w-24 rounded-md border bg-background px-2 py-1 text-sm"
            value={drafts[ent.key] ?? String(ent.value)}
            onChange={e =>
              setDrafts(d => ({ ...d, [ent.key]: e.target.value }))}
            disabled={props.busy}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={
              props.busy
              || (drafts[ent.key] ?? String(ent.value)) === String(ent.value)
            }
            onClick={() => {
              const value = Number(drafts[ent.key]);
              if (!Number.isInteger(value) || value < 0) {
                toast.error('El valor debe ser un entero ≥ 0');
                return;
              }
              props.onSet(ent.key, value);
            }}
          >
            Guardar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={props.busy}
            onClick={() => props.onRemove(ent.key)}
          >
            Quitar
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2 border-t pt-2">
        <input
          type="text"
          list="entitlement-keys"
          placeholder="nueva_clave"
          className="flex-1 rounded-md border bg-background px-2 py-1 text-sm"
          value={newKey}
          onChange={e => setNewKey(e.target.value)}
          disabled={props.busy}
        />
        <datalist id="entitlement-keys">
          {KNOWN_ENTITLEMENT_KEYS.map(k => (
            <option key={k} value={k} />
          ))}
        </datalist>
        <input
          type="number"
          min={0}
          className="w-24 rounded-md border bg-background px-2 py-1 text-sm"
          value={newValue}
          onChange={e => setNewValue(e.target.value)}
          disabled={props.busy}
        />
        <Button size="sm" onClick={addNew} disabled={props.busy}>
          Agregar
        </Button>
      </div>
    </div>
  );
}

export function PlansStudioClient(props: { plans: PlatformPlan[] }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PlatformPlan | null>(null);
  const [form, setForm] = useState<PlanFormState>(() => emptyForm());

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success('Cambios guardados');
        setCreating(false);
        setEditing(null);
        router.refresh();
      } else {
        toast.error(result.error ?? 'Error inesperado');
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Planes y precios</h1>
          <p className="text-sm text-muted-foreground">
            Catálogo vivo: lo que cambies acá aplica de inmediato en toda la
            plataforma.
          </p>
        </div>
        <Button
          onClick={() => {
            setForm(emptyForm());
            setCreating(true);
          }}
        >
          Nuevo plan
        </Button>
      </div>

      <div className="
        grid grid-cols-1 gap-4
        lg:grid-cols-2
      "
      >
        {props.plans.map(plan => (
          <div
            key={plan.id}
            className={`
              rounded-xl border bg-card p-4
              ${plan.isArchived
            ? `opacity-60`
            : ''}
            `}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">{plan.name}</h2>
                  <code className="text-xs text-muted-foreground">
                    {plan.slug}
                  </code>
                </div>
                <div className="mt-1 text-xl font-bold">
                  {copFmt.format(plan.priceMonthlyCop)}
                  <span className="text-sm font-normal text-muted-foreground">
                    {' '}
                    / mes
                  </span>
                  {plan.priceAnnualCop !== null && (
                    <span className="
                      ml-2 text-sm font-normal text-muted-foreground
                    "
                    >
                      {copFmt.format(plan.priceAnnualCop)}
                      {' '}
                      / año
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                {plan.isDefault && <Badge>Predeterminado</Badge>}
                {!plan.isPublic && <Badge variant="secondary">Oculto</Badge>}
                {plan.isArchived && (
                  <Badge variant="destructive">Archivado</Badge>
                )}
              </div>
            </div>

            {plan.description && (
              <p className="mt-1 text-sm text-muted-foreground">
                {plan.description}
              </p>
            )}

            <EntitlementsEditor
              plan={plan}
              busy={pending}
              onSet={(key, value) =>
                run(() => setPlanEntitlement(plan.id, key, value))}
              onRemove={key => run(() => removePlanEntitlement(plan.id, key))}
            />

            <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setForm(formFromPlan(plan));
                  setEditing(plan);
                }}
              >
                Editar
              </Button>
              {!plan.isDefault && !plan.isArchived && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => run(() => setDefaultPlan(plan.id))}
                >
                  Hacer predeterminado
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={pending || (plan.isDefault && !plan.isArchived)}
                onClick={async () => {
                  if (!plan.isArchived) {
                    const ok = await confirm({
                      title: `¿Archivar el plan ${plan.name}?`,
                      description:
                        'Los negocios que ya lo tienen conservan sus límites, pero nadie más podrá elegirlo.',
                      confirmText: 'Archivar',
                    });
                    if (!ok) {
                      return;
                    }
                  }
                  run(() => setPlanArchived(plan.id, !plan.isArchived));
                }}
              >
                {plan.isArchived ? 'Restaurar' : 'Archivar'}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <PlanFormDialog
        open={creating}
        title="Nuevo plan"
        form={form}
        slugEditable
        busy={pending}
        onChange={setForm}
        onClose={() => setCreating(false)}
        onSubmit={() =>
          run(() => createPlan({ ...fieldsFromForm(form), slug: form.slug }))}
      />

      <PlanFormDialog
        open={editing !== null}
        title={`Editar plan ${editing?.name ?? ''}`}
        form={form}
        slugEditable={false}
        busy={pending}
        onChange={setForm}
        onClose={() => setEditing(null)}
        onSubmit={() => {
          if (editing) {
            run(() => updatePlan(editing.id, fieldsFromForm(form)));
          }
        }}
      />
    </div>
  );
}
