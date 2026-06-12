'use client';

import type { ActionResult } from '@/libs/action-result';
import {
  ArrowLeftRightIcon,
  BanknoteIcon,
  BarChart3Icon,
  BikeIcon,
  BoxesIcon,
  EyeIcon,
  FileTextIcon,
  HandCoinsIcon,
  MonitorIcon,
  PackageIcon,
  PencilIcon,
  RotateCcwIcon,
  ShoppingCartIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TruckIcon,
  UsersIcon,
  WalletIcon,
} from 'lucide-react';
import { useCallback, useState, useTransition } from 'react';
import {
  deleteEmployee,
  invite,
  listEmployees,
  listPendingInvitations,
  resendInvitation,
  resetCashierPin,
  revokeInvitation,
  setEmployeeActive,
  updateEmployee,
} from '@/actions/employees';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Switch } from '@/components/ui/switch';
import {
  ACTION_PERMISSIONS,
  MODULE_PERMISSIONS,
  POS_CORE_MODULES,
} from '@/libs/permissions';
import { CASHIERS_LIMIT_REACHED } from '@/libs/plan-limits';
import { cn } from '@/utils/Helpers';

type EmployeeRow = Awaited<ReturnType<typeof listEmployees>>[number];
type InvitationRow = Awaited<ReturnType<typeof listPendingInvitations>>[number];
type ActionFailure = Extract<ActionResult<unknown>, { ok: false }>;

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-xs font-medium text-muted-foreground';

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

function formatDate(date: Date | string) {
  return dateFmt.format(new Date(date));
}

type LimitErrorPayload = {
  code: 'cashiers_limit_reached';
  plan: string;
  limit: number;
  used: number;
  base: number;
  addons: number;
};

// A coded failure result carries the real numbers in `meta`, so the client can
// render the upgrade CTA. Returns null when the failure isn't a limit error.
function limitPayload(failure: ActionFailure): LimitErrorPayload | null {
  if (failure.code !== CASHIERS_LIMIT_REACHED) {
    return null;
  }
  const meta = failure.meta ?? {};
  return {
    code: 'cashiers_limit_reached',
    plan: String(meta.plan ?? ''),
    limit: Number(meta.limit ?? 0),
    used: Number(meta.used ?? 0),
    base: Number(meta.base ?? 0),
    addons: Number(meta.addons ?? 0),
  };
}

/** Builds a {key: boolean} map from a list of granted keys. */
function modulesToMap(keys: string[] | null | undefined): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const k of keys ?? []) {
    map[k] = true;
  }
  return map;
}

function permsToMap(
  perms: Record<string, unknown> | null | undefined,
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(perms ?? {})) {
    map[k] = Boolean(v);
  }
  return map;
}

/**
 * Toggles one module with the cashier-bundle cascade. Granting "Caja registradora
 * (POS)" pre-ticks the cashier core bundle ({@link POS_CORE_MODULES}: caja,
 * ventas, fiados, clientes) as a convenience — the owner can untick. Unticking any
 * core module drops the POS grant, because a cashier needs the full bundle to
 * operate the counter. Non-core modules toggle independently — POS is never
 * implied by them.
 */
function toggleModuleCascade(
  prev: Record<string, boolean>,
  key: string,
): Record<string, boolean> {
  const next = { ...prev, [key]: !prev[key] };
  if (key === 'pos') {
    if (next.pos) {
      for (const m of POS_CORE_MODULES) {
        next[m] = true;
      }
    }
    return next;
  }
  if (POS_CORE_MODULES.includes(key) && !next[key]) {
    next.pos = false;
  }
  return next;
}

// Lucide icon per grantable module/action. Keeps `permissions.ts` free of React
// deps (it runs on the server too); the visual layer maps keys to icons here.
const MODULE_ICONS: Record<string, typeof MonitorIcon> = {
  pos: MonitorIcon,
  cash: WalletIcon,
  sales: ShoppingCartIcon,
  fiados: HandCoinsIcon,
  products: PackageIcon,
  inventory: BoxesIcon,
  customers: UsersIcon,
  suppliers: TruckIcon,
  reports: BarChart3Icon,
  delivery: BikeIcon,
  facturas: FileTextIcon,
};

const ACTION_ICONS: Record<string, typeof MonitorIcon> = {
  'sales.refund': RotateCcwIcon,
  'cash.withdraw': BanknoteIcon,
  'cash.adjust': SlidersHorizontalIcon,
  'inventory.edit': PencilIcon,
  'reports.view': EyeIcon,
};

// One permission row: icon + label + optional hint on the left, a Switch on the
// right. Mirrors the Agente IA "Modelos Inteligentes" cards.
function ToggleCard({
  icon: Icon,
  label,
  hint,
  checked,
  onToggle,
  badge,
  highlighted,
}: {
  icon: typeof MonitorIcon;
  label: string;
  hint?: string;
  checked: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
  highlighted?: boolean;
}) {
  return (
    <div
      className={cn(
        `
          flex items-start justify-between gap-3 rounded-md border bg-background
          p-3 transition-colors
        `,
        highlighted
          ? 'border-primary/50 bg-primary/5'
          : checked && 'border-primary/40',
      )}
    >
      <div className="flex items-start gap-2.5 pr-1">
        <Icon
          className={cn(
            'mt-0.5 size-4 shrink-0 text-muted-foreground',
            (checked || highlighted) && 'text-primary',
          )}
        />
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-sm/tight font-medium">
            {label}
            {badge}
          </div>
          {hint && (
            <p className="text-xs/snug text-muted-foreground">{hint}</p>
          )}
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onToggle} aria-label={label} />
    </div>
  );
}

// Shared grant controls used by both the invite and edit dialogs. There are no
// role tiers: the owner ticks exactly what this user can see and do. The POS
// "Cajero" card is the master of the cashier bundle (see toggleModuleCascade).
function GrantFields({
  modules,
  actions,
  canConfirmTransfers,
  onToggleModule,
  onToggleAction,
  onToggleTransfers,
}: {
  modules: Record<string, boolean>;
  actions: Record<string, boolean>;
  canConfirmTransfers: boolean;
  onToggleModule: (key: string) => void;
  onToggleAction: (key: string) => void;
  onToggleTransfers: () => void;
}) {
  const otherModules = MODULE_PERMISSIONS.filter(m => m.key !== 'pos');
  return (
    <div className="space-y-5">
      <ToggleCard
        icon={MonitorIcon}
        label="Caja registradora (POS)"
        hint="Combo de cajero: activa Caja, Ventas, Fiados y Clientes. Si desmarcás cualquiera de esos, el cajero se apaga."
        checked={!!modules.pos}
        onToggle={() => onToggleModule('pos')}
        highlighted
        badge={(
          <Badge variant="secondary" className="gap-1">
            <SparklesIcon className="size-3" />
            Cajero
          </Badge>
        )}
      />

      <div className="space-y-2">
        <div className={labelCls}>Vistas / Módulos</div>
        <div className="
          grid gap-2
          sm:grid-cols-2
        "
        >
          {otherModules.map((m) => {
            const Icon = MODULE_ICONS[m.key] ?? PackageIcon;
            const isCore = POS_CORE_MODULES.includes(m.key);
            return (
              <ToggleCard
                key={m.key}
                icon={Icon}
                label={m.label}
                hint={m.hint}
                checked={!!modules[m.key]}
                onToggle={() => onToggleModule(m.key)}
                badge={isCore
                  ? (
                      <Badge variant="outline" className="text-[10px]">
                        Cajero
                      </Badge>
                    )
                  : undefined}
              />
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div className={labelCls}>Acciones sensibles</div>
        <div className="
          grid gap-2
          sm:grid-cols-2
        "
        >
          {ACTION_PERMISSIONS.map((p) => {
            const Icon = ACTION_ICONS[p.key] ?? SlidersHorizontalIcon;
            return (
              <ToggleCard
                key={p.key}
                icon={Icon}
                label={p.label}
                checked={!!actions[p.key]}
                onToggle={() => onToggleAction(p.key)}
              />
            );
          })}
        </div>
      </div>

      <ToggleCard
        icon={ArrowLeftRightIcon}
        label="Puede confirmar transferencias"
        hint="Permite marcar como recibidas las transferencias desde la caja."
        checked={canConfirmTransfers}
        onToggle={onToggleTransfers}
      />
    </div>
  );
}

export function EmployeesClient({
  initialEmployees,
  initialInvitations,
}: {
  initialEmployees: EmployeeRow[];
  initialInvitations: InvitationRow[];
}) {
  const confirm = useConfirm();
  const [employees, setEmployees] = useState(initialEmployees);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [lastEmailSent, setLastEmailSent] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<LimitErrorPayload | null>(null);
  // When deleteEmployee returns has_history, stores the employee id so we can
  // show a "Deactivate instead" fallback prompt.
  const [deleteHistoryId, setDeleteHistoryId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const refresh = useCallback(() => {
    startTransition(async () => {
      const [emps, invs] = await Promise.all([
        listEmployees(),
        listPendingInvitations(),
      ]);
      setEmployees(emps);
      setInvitations(invs);
    });
  }, []);

  const handleFailure = (failure: ActionFailure) => {
    const limit = limitPayload(failure);
    if (limit) {
      setLimitError(limit);
    } else {
      setError(failure.error);
    }
  };

  const handleRevoke = async (id: string) => {
    const ok = await confirm({
      title: '¿Revocar esta invitación?',
      description: 'El enlace dejará de funcionar y la persona no podrá unirse con él.',
      confirmText: 'Revocar',
      tone: 'destructive',
    });
    if (!ok) {
      return;
    }
    startTransition(async () => {
      try {
        const result = await revokeInvitation(id);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        refresh();
      } catch {
        setError('No se pudo revocar');
      }
    });
  };

  const handleResetPin = async (id: string, name: string) => {
    const ok = await confirm({
      title: `¿Resetear el PIN de ${name}?`,
      description: 'Quedará sin PIN y podrá configurar uno nuevo desde la caja.',
      confirmText: 'Resetear PIN',
    });
    if (!ok) {
      return;
    }
    startTransition(async () => {
      try {
        const result = await resetCashierPin(id);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        refresh();
      } catch {
        setError('No se pudo resetear el PIN');
      }
    });
  };

  const handleToggleActive = (emp: EmployeeRow) => {
    startTransition(async () => {
      try {
        const result = await setEmployeeActive(emp.id, !emp.active);
        if (!result.ok) {
          handleFailure(result);
          return;
        }
        refresh();
      } catch {
        setError('No se pudo cambiar el estado');
      }
    });
  };

  const handleResend = (id: string) => {
    startTransition(async () => {
      try {
        const result = await resendInvitation(id);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setLastInviteUrl(result.data.inviteUrl);
        setLastEmailSent(result.data.emailSent);
        refresh();
      } catch {
        setError('No se pudo reenviar');
      }
    });
  };

  const handleDelete = async (emp: EmployeeRow) => {
    const ok = await confirm({
      title: `¿Eliminar a ${emp.name}?`,
      description:
        'Esto elimina al empleado de forma permanente. Solo se pueden eliminar empleados sin historial de ventas, movimientos o entregas.',
      confirmText: 'Eliminar',
      tone: 'destructive',
    });
    if (!ok) {
      return;
    }
    startTransition(async () => {
      try {
        const result = await deleteEmployee(emp.id);
        if (!result.ok) {
          if (result.code === 'has_history') {
            setDeleteHistoryId(emp.id);
          } else {
            setError(result.error);
          }
          return;
        }
        refresh();
      } catch {
        setError('No se pudo eliminar al empleado');
      }
    });
  };

  return (
    <div className="space-y-8">
      {error && (
        <div className="
          rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2
          text-sm text-destructive
        "
        >
          {error}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => setError(null)}
          >
            Descartar
          </button>
        </div>
      )}

      {limitError && (
        <div className="
          rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm
          text-amber-900
        "
        >
          <div className="font-semibold">Límite de usuarios alcanzado</div>
          <div>
            El plan
            {' '}
            <span className="font-mono">{limitError.plan}</span>
            {' '}
            permite
            {' '}
            {limitError.base}
            {' '}
            usuario
            {limitError.base === 1 ? '' : 's'}
            {' '}
            (+
            {limitError.addons}
            {' '}
            adicional
            {limitError.addons === 1 ? '' : 'es'}
            ) =
            {' '}
            {limitError.limit}
            . En uso actualmente:
            {' '}
            {limitError.used}
            .
          </div>
          <button
            type="button"
            className="mt-1 underline"
            onClick={() => setLimitError(null)}
          >
            Descartar
          </button>
        </div>
      )}

      {deleteHistoryId && (
        <div className="
          rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm
          text-amber-900
        "
        >
          <div className="font-semibold">No se puede eliminar — el empleado tiene historial</div>
          <div className="mt-1">
            Este empleado tiene ventas, movimientos de caja o entregas registradas. Para quitarle
            el acceso sin perder los registros, desactivalo en su lugar.
          </div>
          <div className="mt-2 flex gap-3">
            <button
              type="button"
              className="underline"
              onClick={() => {
                const emp = employees.find(e => e.id === deleteHistoryId);
                if (emp) {
                  handleToggleActive(emp);
                }
                setDeleteHistoryId(null);
              }}
            >
              Desactivar en su lugar
            </button>
            <button
              type="button"
              className="underline"
              onClick={() => setDeleteHistoryId(null)}
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {lastInviteUrl && (
        <div className="
          rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm
          text-emerald-900
        "
        >
          <div className="font-semibold">
            {lastEmailSent
              ? 'Invitación enviada por correo'
              : 'Enlace de invitación'}
          </div>
          <div className="mt-1 text-xs">
            {lastEmailSent
              ? 'Le enviamos un correo a la persona para que cree su contraseña. Si no le llega, pasale este enlace:'
              : 'Copiá este enlace y pasáselo a la persona para que cree su contraseña.'}
          </div>
          <div className="mt-1 font-mono text-xs break-all">
            {lastInviteUrl}
          </div>
          <button
            type="button"
            className="mt-2 underline"
            onClick={() => {
              navigator.clipboard.writeText(lastInviteUrl);
            }}
          >
            Copiar
          </button>
          <button
            type="button"
            className="mt-2 ml-3 underline"
            onClick={() => setLastInviteUrl(null)}
          >
            Descartar
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Usuarios del negocio</div>
        <Button
          onClick={() => setShowInviteModal(true)}
          disabled={pending}
        >
          Invitar usuario
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Nombre</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Permisos</th>
              <th className="px-3 py-2">PIN</th>
              <th className="px-3 py-2">Creado</th>
              <th className="px-3 py-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 && (
              <tr>
                <td
                  className="px-3 py-6 text-center text-muted-foreground"
                  colSpan={7}
                >
                  Aún no hay usuarios
                </td>
              </tr>
            )}
            {employees.map(emp => (
              <tr key={emp.id} className="border-t">
                <td className="px-3 py-2">{emp.name}</td>
                <td className="px-3 py-2">{emp.email}</td>
                <td className="px-3 py-2">
                  {emp.active
                    ? (
                        <span className="text-emerald-700">activo</span>
                      )
                    : (
                        <span className="text-muted-foreground">inactivo</span>
                      )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {(emp.enabledModules ?? []).join(', ') || '—'}
                </td>
                <td className="px-3 py-2 text-xs">
                  {emp.hasPin
                    ? <span className="text-emerald-700">Configurado</span>
                    : <span className="text-muted-foreground">Sin PIN</span>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {formatDate(emp.createdAt)}
                </td>
                <td className="space-x-1 px-3 py-2 whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setEditing(emp)}
                    disabled={pending}
                  >
                    Editar permisos
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleToggleActive(emp)}
                    disabled={pending}
                  >
                    {emp.active ? 'Desactivar' : 'Activar'}
                  </Button>
                  {emp.hasPin && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleResetPin(emp.id, emp.name)}
                      disabled={pending}
                      title="Deja al usuario sin PIN para que configure uno nuevo"
                    >
                      Resetear PIN
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleDelete(emp)}
                    disabled={pending}
                    title="Eliminar al empleado de forma permanente (solo si no tiene historial)"
                  >
                    Eliminar
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="mb-3 text-lg font-semibold">Invitaciones pendientes</div>
        <div className="overflow-x-auto rounded-md border bg-background">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase">
              <tr>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Nombre</th>
                <th className="px-3 py-2">Vence</th>
                <th className="px-3 py-2">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {invitations.length === 0 && (
                <tr>
                  <td
                    className="px-3 py-6 text-center text-muted-foreground"
                    colSpan={4}
                  >
                    No hay invitaciones pendientes
                  </td>
                </tr>
              )}
              {invitations.map(inv => (
                <tr key={inv.id} className="border-t">
                  <td className="px-3 py-2">{inv.email}</td>
                  <td className="px-3 py-2">{inv.name}</td>
                  <td className="px-3 py-2 text-xs">
                    {formatDate(inv.expiresAt)}
                    {inv.expired && (
                      <span className="ml-2 text-destructive">(vencida)</span>
                    )}
                  </td>
                  <td className="space-x-2 px-3 py-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleResend(inv.id)}
                      disabled={pending}
                    >
                      Reenviar
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleRevoke(inv.id)}
                      disabled={pending}
                    >
                      Revocar
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setLastInviteUrl(inv.inviteUrl);
                        setLastEmailSent(null);
                      }}
                    >
                      Ver enlace
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showInviteModal && (
        <InviteModal
          onClose={() => setShowInviteModal(false)}
          onSuccess={(inviteUrl, emailSent) => {
            setLastInviteUrl(inviteUrl);
            setLastEmailSent(emailSent);
            setShowInviteModal(false);
            setLimitError(null);
            refresh();
          }}
          onFailure={handleFailure}
        />
      )}

      {editing && (
        <EditModal
          employee={editing}
          onClose={() => setEditing(null)}
          onSuccess={() => {
            setEditing(null);
            refresh();
          }}
          onFailure={(failure) => {
            setEditing(null);
            handleFailure(failure);
          }}
        />
      )}
    </div>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="
        max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-background
        p-6 shadow-lg
      "
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="
              text-muted-foreground
              hover:text-foreground
            "
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function InviteModal({
  onClose,
  onSuccess,
  onFailure,
}: {
  onClose: () => void;
  onSuccess: (inviteUrl: string, emailSent: boolean) => void;
  onFailure: (failure: ActionFailure) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [modules, setModules] = useState<Record<string, boolean>>({});
  const [actions, setActions] = useState<Record<string, boolean>>({});
  const [canConfirmTransfers, setCanConfirmTransfers] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const handleToggleModule = (key: string) => {
    setModules(prev => toggleModuleCascade(prev, key));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const enabledModules = Object.entries(modules)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const permissions = Object.fromEntries(
        Object.entries(actions).filter(([, v]) => v),
      );
      const result = await invite({
        email,
        name,
        phone: phone.trim() || null,
        permissions,
        enabledModules,
        canConfirmTransfers,
      });
      if (!result.ok) {
        onFailure(result);
        return;
      }
      onSuccess(result.data.inviteUrl, result.data.emailSent);
    } catch {
      onFailure({ ok: false, error: 'No se pudo enviar la invitación' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title="Invitar usuario" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="emp-email" className={labelCls}>
            Email
          </label>
          <input
            id="emp-email"
            type="email"
            required
            value={email}
            onChange={e => setEmail(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="emp-name" className={labelCls}>
            Nombre
          </label>
          <input
            id="emp-name"
            type="text"
            required
            value={name}
            onChange={e => setName(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="emp-phone" className={labelCls}>
            WhatsApp
          </label>
          <input
            id="emp-phone"
            type="tel"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="+57 300 000 0000"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Opcional. Lo usa el asistente para escribirle al empleado (cambios de
            precio, ofertas, cobertura de turnos). El empleado puede actualizarlo
            desde su propio panel.
          </p>
        </div>

        <GrantFields
          modules={modules}
          actions={actions}
          canConfirmTransfers={canConfirmTransfers}
          onToggleModule={handleToggleModule}
          onToggleAction={k => setActions(p => ({ ...p, [k]: !p[k] }))}
          onToggleTransfers={() => setCanConfirmTransfers(v => !v)}
        />

        <p className="
          rounded-md border border-input bg-muted/30 p-3 text-xs
          text-muted-foreground
        "
        >
          Todo usuario puede entrar al panel web con la misma contraseña; allí
          solo verá los módulos que le habilites arriba.
        </p>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancelar
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Enviando…' : 'Crear invitación'}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

function EditModal({
  employee,
  onClose,
  onSuccess,
  onFailure,
}: {
  employee: EmployeeRow;
  onClose: () => void;
  onSuccess: () => void;
  onFailure: (failure: ActionFailure) => void;
}) {
  const [modules, setModules] = useState<Record<string, boolean>>(
    () => modulesToMap(employee.enabledModules),
  );
  const [actions, setActions] = useState<Record<string, boolean>>(
    () => permsToMap(employee.permissions as Record<string, unknown> | null),
  );
  const [canConfirmTransfers, setCanConfirmTransfers] = useState(
    employee.canConfirmTransfers,
  );
  const [salary, setSalary] = useState(
    employee.salary != null ? String(employee.salary) : '',
  );
  const [phone, setPhone] = useState(employee.phone ?? '');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const enabledModules = Object.entries(modules)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const permissions = Object.fromEntries(
        Object.entries(actions).filter(([, v]) => v),
      );
      const salaryValue = salary.trim() !== '' ? Number(salary) : null;
      const result = await updateEmployee(employee.id, {
        permissions,
        enabledModules,
        canConfirmTransfers,
        salary: salaryValue,
        phone: phone.trim() || null,
      });
      if (!result.ok) {
        onFailure(result);
        return;
      }
      onSuccess();
    } catch {
      onFailure({ ok: false, error: 'No se pudieron guardar los datos del empleado' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`Editar a ${employee.name}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {employee.email}
        </p>

        {/* Salary & phone */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="edit-salary" className={labelCls}>
              Salario mensual
            </label>
            <input
              id="edit-salary"
              type="number"
              min="0"
              step="0.01"
              value={salary}
              onChange={e => setSalary(e.target.value)}
              placeholder="0.00"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="edit-phone" className={labelCls}>
              WhatsApp
            </label>
            <input
              id="edit-phone"
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+57 300 000 0000"
              className={inputCls}
            />
          </div>
        </div>

        <GrantFields
          modules={modules}
          actions={actions}
          canConfirmTransfers={canConfirmTransfers}
          onToggleModule={k => setModules(p => toggleModuleCascade(p, k))}
          onToggleAction={k => setActions(p => ({ ...p, [k]: !p[k] }))}
          onToggleTransfers={() => setCanConfirmTransfers(v => !v)}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancelar
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
