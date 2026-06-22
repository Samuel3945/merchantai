'use client';

import type {
  OrgStatus,
  PlatformAgentKind,
  PlatformOrgDetail,
} from '@/actions/platform-orgs';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { startImpersonation } from '@/actions/platform-impersonation';
import {
  assignPlanToOrg,
  grantAddon,
  grantCredits,
  resetUsage,
  saveOrgMetadata,
  setAddonActive,
  setOrgSetting,
} from '@/actions/platform-orgs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast-store';

const copFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const inputClass
  = 'rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

const STATUS_OPTIONS: { value: OrgStatus; label: string }[] = [
  { value: 'none', label: 'Sin estado' },
  { value: 'trial', label: 'Prueba' },
  { value: 'vip', label: 'VIP' },
  { value: 'at_risk', label: 'En riesgo' },
  { value: 'churned', label: 'Perdido' },
];

const KNOWN_ADDONS = ['pos_device', 'pos_cashier'];
const KNOWN_SETTING_KEYS = ['smartStockEnabled', 'modules.ai'];

const AGENT_LABELS: Record<PlatformAgentKind, string> = {
  sales_manager: 'Sales Manager',
  customer_service: 'Customer Service',
};

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="font-semibold">{props.title}</h2>
      <div className="mt-3">{props.children}</div>
    </section>
  );
}

export function BusinessCockpitClient(props: {
  org: PlatformOrgDetail;
  planOptions: { slug: string; name: string; isPublic: boolean }[];
}) {
  const { org } = props;
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();

  const [status, setStatus] = useState<OrgStatus>(org.status);
  const [tagsText, setTagsText] = useState(org.tags.join(', '));
  const [groupName, setGroupName] = useState(org.groupName ?? '');
  const [notes, setNotes] = useState(org.notes ?? '');
  const [knownIssues, setKnownIssues] = useState(org.knownIssues ?? '');

  const [selectedPlan, setSelectedPlan] = useState(org.planSlug);
  const [addonKey, setAddonKey] = useState('pos_device');
  const [addonQty, setAddonQty] = useState('1');
  const [creditAgent, setCreditAgent]
    = useState<PlatformAgentKind>('sales_manager');
  const [creditAmount, setCreditAmount] = useState('100');
  const [settingKey, setSettingKey] = useState('');
  const [settingValue, setSettingValue] = useState('');
  const [impersonationReason, setImpersonationReason] = useState('');
  const [impersonationUrl, setImpersonationUrl] = useState<string | null>(null);

  // AI preview is an opt-in per-org override (app_setting modules.ai). Default
  // OFF: only orgs the operator flips on here see the AI agent and Domicilios.
  const aiPreviewOn
    = org.settings.find(s => s.key === 'modules.ai')?.value === 'true';

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success('Cambios guardados');
        router.refresh();
      } else {
        toast.error(result.error ?? 'Error inesperado');
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{org.name}</h1>
          <p className="text-xs text-muted-foreground">{org.organizationId}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{org.planName}</Badge>
          {org.membersCount !== null && (
            <span className="text-sm text-muted-foreground">
              {org.membersCount}
              {' '}
              miembros
            </span>
          )}
        </div>
      </div>

      <div className="
        grid grid-cols-2 gap-4
        sm:grid-cols-4
      "
      >
        <div className="rounded-xl border bg-card p-3">
          <div className="text-xs text-muted-foreground">Ventas 30d</div>
          <div className="text-xl font-bold">{org.sales30d}</div>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <div className="text-xs text-muted-foreground">Facturación 30d</div>
          <div className="text-xl font-bold">{copFmt.format(org.revenue30d)}</div>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <div className="text-xs text-muted-foreground">Cajeros activos</div>
          <div className="text-xl font-bold">{org.activeCashiers}</div>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <div className="text-xs text-muted-foreground">Última venta</div>
          <div className="text-xl font-bold">
            {org.lastSaleAt
              ? new Date(org.lastSaleAt).toLocaleDateString('es-CO', {
                  day: '2-digit',
                  month: 'short',
                })
              : '—'}
          </div>
        </div>
      </div>

      <Section title="Vista previa de IA">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm text-muted-foreground">
            Muestra el Agente IA y Domicilios solo a esta organización para
            probar. Mientras esté inactiva, el negocio no ve nada de IA.
          </p>
          <div className="flex items-center gap-2">
            <Badge variant={aiPreviewOn ? 'default' : 'secondary'}>
              {aiPreviewOn ? 'Activa' : 'Inactiva'}
            </Badge>
            <Button
              variant={aiPreviewOn ? 'secondary' : 'default'}
              disabled={pending}
              onClick={() =>
                run(() =>
                  setOrgSetting(
                    org.organizationId,
                    'modules.ai',
                    aiPreviewOn ? 'false' : 'true',
                  ))}
            >
              {aiPreviewOn ? 'Desactivar IA' : 'Activar IA'}
            </Button>
          </div>
        </div>
      </Section>

      <div className="
        grid grid-cols-1 gap-4
        lg:grid-cols-2
      "
      >
        <Section title="Plan">
          <div className="flex items-center gap-2">
            <select
              className={`
                ${inputClass}
                flex-1
              `}
              value={selectedPlan}
              onChange={e => setSelectedPlan(e.target.value)}
              disabled={pending}
            >
              {props.planOptions.map(p => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                  {p.isPublic ? '' : ' (oculto)'}
                </option>
              ))}
            </select>
            <Button
              disabled={pending || selectedPlan === org.planSlug}
              onClick={async () => {
                const ok = await confirm({
                  title: `¿Asignar el plan "${selectedPlan}" a ${org.name}?`,
                  description:
                    'Los contadores de IA se reinician a los límites del nuevo plan.',
                  confirmText: 'Asignar',
                });
                if (ok) {
                  run(() => assignPlanToOrg(org.organizationId, selectedPlan));
                }
              }}
            >
              Asignar
            </Button>
          </div>
        </Section>

        <Section title="Créditos de IA">
          <div className="space-y-2">
            {org.counters.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Sin contadores todavía.
              </p>
            )}
            {org.counters.map(c => (
              <div
                key={c.agentKind}
                className="flex items-center justify-between text-sm"
              >
                <span>
                  {AGENT_LABELS[c.agentKind as PlatformAgentKind]
                    ?? c.agentKind}
                </span>
                <span className="text-muted-foreground">
                  {c.used}
                  {' '}
                  /
                  {' '}
                  {c.monthlyLimit + c.toppedUp}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: '¿Reiniciar el consumo a 0?',
                      confirmText: 'Reiniciar',
                    });
                    if (ok) {
                      run(() =>
                        resetUsage(
                          org.organizationId,
                          c.agentKind as PlatformAgentKind,
                        ),
                      );
                    }
                  }}
                >
                  Reiniciar uso
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2 border-t pt-2">
              <select
                className={inputClass}
                value={creditAgent}
                onChange={e =>
                  setCreditAgent(e.target.value as PlatformAgentKind)}
                disabled={pending}
              >
                <option value="sales_manager">Sales Manager</option>
                <option value="customer_service">Customer Service</option>
              </select>
              <input
                type="number"
                min={1}
                className={`
                  ${inputClass}
                  w-24
                `}
                value={creditAmount}
                onChange={e => setCreditAmount(e.target.value)}
                disabled={pending}
              />
              <Button
                size="sm"
                disabled={pending}
                onClick={() => {
                  const requests = Number(creditAmount);
                  if (!Number.isInteger(requests) || requests < 1) {
                    toast.error('Cantidad inválida');
                    return;
                  }
                  run(() =>
                    grantCredits(org.organizationId, creditAgent, requests),
                  );
                }}
              >
                Regalar créditos
              </Button>
            </div>
          </div>
        </Section>

        <Section title="Add-ons">
          <div className="space-y-2">
            {org.addons.length === 0 && (
              <p className="text-sm text-muted-foreground">Sin add-ons.</p>
            )}
            {org.addons.map(addon => (
              <div
                key={addon.id}
                className="flex items-center justify-between text-sm"
              >
                <span>
                  <code>{addon.addon}</code>
                  {' '}
                  ×
                  {addon.qty}
                </span>
                <div className="flex items-center gap-2">
                  {!addon.active && <Badge variant="secondary">Inactivo</Badge>}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => run(() => setAddonActive(addon.id, !addon.active))}
                  >
                    {addon.active ? 'Desactivar' : 'Activar'}
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2 border-t pt-2">
              <input
                type="text"
                list="addon-keys"
                className={`
                  ${inputClass}
                  flex-1
                `}
                value={addonKey}
                onChange={e => setAddonKey(e.target.value)}
                disabled={pending}
              />
              <datalist id="addon-keys">
                {KNOWN_ADDONS.map(a => (
                  <option key={a} value={a} />
                ))}
              </datalist>
              <input
                type="number"
                min={1}
                className={`
                  ${inputClass}
                  w-20
                `}
                value={addonQty}
                onChange={e => setAddonQty(e.target.value)}
                disabled={pending}
              />
              <Button
                size="sm"
                disabled={pending}
                onClick={() => {
                  const qty = Number(addonQty);
                  if (!Number.isInteger(qty) || qty < 1) {
                    toast.error('Cantidad inválida');
                    return;
                  }
                  run(() => grantAddon(org.organizationId, addonKey, qty));
                }}
              >
                Otorgar
              </Button>
            </div>
          </div>
        </Section>

        <Section title="Ajustes del negocio (overrides)">
          <div className="space-y-2">
            {org.settings.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Sin ajustes guardados.
              </p>
            )}
            {org.settings.map(s => (
              <div
                key={s.key}
                className="flex items-center justify-between text-sm"
              >
                <code className="truncate">{s.key}</code>
                <span className="text-muted-foreground">{s.value || '""'}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 border-t pt-2">
              <input
                type="text"
                list="setting-keys"
                placeholder="clave"
                className={`
                  ${inputClass}
                  flex-1
                `}
                value={settingKey}
                onChange={e => setSettingKey(e.target.value)}
                disabled={pending}
              />
              <datalist id="setting-keys">
                {KNOWN_SETTING_KEYS.map(k => (
                  <option key={k} value={k} />
                ))}
              </datalist>
              <input
                type="text"
                placeholder="valor"
                className={`
                  ${inputClass}
                  w-32
                `}
                value={settingValue}
                onChange={e => setSettingValue(e.target.value)}
                disabled={pending}
              />
              <Button
                size="sm"
                disabled={pending || !settingKey.trim()}
                onClick={() =>
                  run(() =>
                    setOrgSetting(org.organizationId, settingKey, settingValue),
                  )}
              >
                Guardar
              </Button>
            </div>
          </div>
        </Section>

        <Section title="Perfil del negocio">
          {org.profile === null
            ? (
                <p className="text-sm text-muted-foreground">
                  Todavía no se capturó el perfil (se calcula automáticamente
                  con la actividad del negocio).
                </p>
              )
            : (
                <div className="space-y-2 text-sm">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <span className="text-muted-foreground">Productos</span>
                    <span>
                      {org.profile.activeProductCount}
                      {' '}
                      activos /
                      {' '}
                      {org.profile.productCount}
                    </span>
                    <span className="text-muted-foreground">Perecederos</span>
                    <span>{org.profile.perishableCount}</span>
                    <span className="text-muted-foreground">Por mayor</span>
                    <span>{org.profile.wholesaleCount}</span>
                    <span className="text-muted-foreground">Categorías</span>
                    <span>{org.profile.distinctCategories}</span>
                    <span className="text-muted-foreground">
                      Unidades en stock
                    </span>
                    <span>{org.profile.totalStockUnits}</span>
                    <span className="text-muted-foreground">
                      Productos vendidos (30d)
                    </span>
                    <span>{org.profile.distinctProductsSold30d}</span>
                    <span className="text-muted-foreground">Tipo inferido</span>
                    <span>{org.profile.inferredBusinessType ?? '—'}</span>
                  </div>
                  {org.profile.topCategories.length > 0 && (
                    <div className="border-t pt-2">
                      <div className="text-xs text-muted-foreground">
                        Categorías principales
                      </div>
                      <div className="flex flex-wrap gap-1 pt-1">
                        {org.profile.topCategories.slice(0, 6).map(c => (
                          <Badge key={c.name} variant="outline">
                            {c.name}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
        </Section>

        <Section title="Actividad reciente">
          {org.recentActivity.length === 0
            ? (
                <p className="text-sm text-muted-foreground">Sin actividad.</p>
              )
            : (
                <ul className="space-y-1 text-sm">
                  {org.recentActivity.map(entry => (
                    <li
                      key={entry.id}
                      className="flex items-center justify-between gap-2"
                    >
                      <code className="truncate text-xs">{entry.action}</code>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {entry.actorType}
                        {' · '}
                        {new Date(entry.createdAt).toLocaleString('es-CO', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
        </Section>
      </div>

      <Section title="Notas del operador">
        <div className="space-y-3">
          <div className="
            grid grid-cols-1 gap-3
            sm:grid-cols-3
          "
          >
            <div>
              <label htmlFor="org-status" className="text-xs font-medium">
                Estado
              </label>
              <select
                id="org-status"
                className={`
                  ${inputClass}
                  w-full
                `}
                value={status}
                onChange={e => setStatus(e.target.value as OrgStatus)}
                disabled={pending}
              >
                {STATUS_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="org-group" className="text-xs font-medium">
                Grupo
              </label>
              <input
                id="org-group"
                type="text"
                className={`
                  ${inputClass}
                  w-full
                `}
                value={groupName}
                placeholder="ej: cadena-norte"
                onChange={e => setGroupName(e.target.value)}
                disabled={pending}
              />
            </div>
            <div>
              <label htmlFor="org-tags" className="text-xs font-medium">
                Tags (separados por coma)
              </label>
              <input
                id="org-tags"
                type="text"
                className={`
                  ${inputClass}
                  w-full
                `}
                value={tagsText}
                placeholder="ej: piloto, mayorista"
                onChange={e => setTagsText(e.target.value)}
                disabled={pending}
              />
            </div>
          </div>
          <div>
            <label htmlFor="org-notes" className="text-xs font-medium">
              Notas internas
            </label>
            <textarea
              id="org-notes"
              rows={3}
              className={`
                ${inputClass}
                w-full
              `}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={pending}
            />
          </div>
          <div>
            <label htmlFor="org-issues" className="text-xs font-medium">
              Problemas conocidos
            </label>
            <textarea
              id="org-issues"
              rows={3}
              className={`
                ${inputClass}
                w-full
              `}
              value={knownIssues}
              onChange={e => setKnownIssues(e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="flex justify-end">
            <Button
              disabled={pending}
              onClick={() =>
                run(() =>
                  saveOrgMetadata(org.organizationId, {
                    status,
                    tags: tagsText.split(','),
                    groupName,
                    notes,
                    knownIssues,
                  }),
                )}
            >
              Guardar notas
            </Button>
          </div>
        </div>
      </Section>

      <Section title="Soporte (acceso al negocio)">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Genera un acceso temporal (30 min) como el dueño del negocio,
            usando la impersonación nativa de Clerk. La sesión queda marcada
            con un banner visible y el acceso se registra en la auditoría.
            Uso exclusivo de soporte.
          </p>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor="imp-reason" className="text-xs font-medium">
                Motivo (obligatorio)
              </label>
              <input
                id="imp-reason"
                type="text"
                className={`
                  ${inputClass}
                  w-full
                `}
                value={impersonationReason}
                placeholder="ej: revisar error reportado en facturación"
                onChange={e => setImpersonationReason(e.target.value)}
                disabled={pending}
              />
            </div>
            <Button
              variant="secondary"
              disabled={pending || impersonationReason.trim().length < 10}
              onClick={async () => {
                const ok = await confirm({
                  title: `¿Generar acceso de soporte a ${org.name}?`,
                  description:
                    'Vas a navegar como el dueño del negocio durante 30 minutos.',
                  confirmText: 'Generar acceso',
                  tone: 'destructive',
                });
                if (!ok) {
                  return;
                }
                startTransition(async () => {
                  const result = await startImpersonation(
                    org.organizationId,
                    impersonationReason,
                  );
                  if (result.ok) {
                    setImpersonationUrl(result.data.url);
                    toast.success('Acceso de soporte generado');
                  } else {
                    toast.error(result.error ?? 'Error inesperado');
                  }
                });
              }}
            >
              Generar acceso
            </Button>
          </div>
          {impersonationUrl && (
            <div className="
              flex items-center justify-between gap-2 rounded-md border
              border-amber-300 bg-amber-50 px-3 py-2 text-sm
            "
            >
              <span className="truncate text-amber-900">
                Acceso listo (expira en 30 min).
              </span>
              <a
                href={impersonationUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 font-medium underline"
              >
                Abrir sesión de soporte
              </a>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
