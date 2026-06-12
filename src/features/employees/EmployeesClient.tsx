'use client';

import type { WorkSchedule } from '@/actions/employees';
import type { ActionResult } from '@/libs/action-result';
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
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import {
  ACTION_PERMISSIONS,
  MODULE_PERMISSIONS,
} from '@/libs/permissions';
import { CASHIERS_LIMIT_REACHED } from '@/libs/plan-limits';

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
 * Toggles one module. Granting "Caja registradora (POS)" pre-ticks every other
 * module as a convenience (a cashier operates the whole counter); the owner can
 * untick any of them afterwards. Other modules toggle independently — POS access
 * is never implied.
 */
function toggleModuleCascade(
  prev: Record<string, boolean>,
  key: string,
): Record<string, boolean> {
  const next = { ...prev, [key]: !prev[key] };
  if (key === 'pos' && next.pos) {
    for (const m of MODULE_PERMISSIONS) {
      next[m.key] = true;
    }
  }
  return next;
}

/** Same cascade for sensitive actions when POS is being granted. */
function allActionsGranted(): Record<string, boolean> {
  return Object.fromEntries(ACTION_PERMISSIONS.map(p => [p.key, true]));
}

// Shared grant checkboxes used by both the invite and edit dialogs. There are no
// role tiers: the owner ticks exactly what this user can see and do.
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
  return (
    <>
      <div>
        <div className={labelCls}>Vistas / Módulos</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {MODULE_PERMISSIONS.map(m => (
            <label key={m.key} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={!!modules[m.key]}
                onChange={() => onToggleModule(m.key)}
              />
              <span>
                {m.label}
                {m.hint && (
                  <span className="block text-xs text-muted-foreground">
                    {m.hint}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className={labelCls}>Acciones sensibles</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {ACTION_PERMISSIONS.map(p => (
            <label key={p.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!actions[p.key]}
                onChange={() => onToggleAction(p.key)}
              />
              {p.label}
            </label>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={canConfirmTransfers}
          onChange={onToggleTransfers}
        />
        Puede confirmar transferencias
      </label>
    </>
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
  const [modules, setModules] = useState<Record<string, boolean>>({});
  const [actions, setActions] = useState<Record<string, boolean>>({});
  const [canConfirmTransfers, setCanConfirmTransfers] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const handleToggleModule = (key: string) => {
    if (key === 'pos' && !modules.pos) {
      setActions(allActionsGranted());
    }
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

const WEEKDAYS: Array<{ key: keyof WorkSchedule; label: string }> = [
  { key: 'mon', label: 'Lunes' },
  { key: 'tue', label: 'Martes' },
  { key: 'wed', label: 'Miércoles' },
  { key: 'thu', label: 'Jueves' },
  { key: 'fri', label: 'Viernes' },
  { key: 'sat', label: 'Sábado' },
  { key: 'sun', label: 'Domingo' },
];

const DEFAULT_START = '08:00';
const DEFAULT_END = '17:00';

function initSchedule(raw: unknown): WorkSchedule {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as WorkSchedule;
  }
  return {};
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
  const [schedule, setSchedule] = useState<WorkSchedule>(
    () => initSchedule(employee.workSchedule),
  );
  const [submitting, setSubmitting] = useState(false);

  const setDay = (key: keyof WorkSchedule, patch: Partial<{ start: string; end: string; off: boolean }>) => {
    setSchedule((prev) => {
      const existing = prev[key] ?? { start: DEFAULT_START, end: DEFAULT_END, off: false };
      return { ...prev, [key]: { ...existing, ...patch } };
    });
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
      const salaryValue = salary.trim() !== '' ? Number(salary) : null;
      const result = await updateEmployee(employee.id, {
        permissions,
        enabledModules,
        canConfirmTransfers,
        salary: salaryValue,
        phone: phone.trim() || null,
        workSchedule: schedule,
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
              Teléfono
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

        {/* Weekly schedule */}
        <div>
          <div className={labelCls}>Horario semanal</div>
          <div className="mt-2 space-y-1">
            {WEEKDAYS.map(({ key, label }) => {
              const day = schedule[key] ?? { start: DEFAULT_START, end: DEFAULT_END, off: false };
              return (
                <div key={key} className="flex items-center gap-2 text-sm">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={!day.off}
                      onChange={e => setDay(key, { off: !e.target.checked })}
                    />
                    Trabaja
                  </label>
                  <input
                    type="time"
                    value={day.start}
                    disabled={day.off}
                    onChange={e => setDay(key, { start: e.target.value })}
                    className="
                      h-7 rounded-sm border border-input bg-transparent px-1
                      text-xs
                      disabled:opacity-40
                    "
                  />
                  <span className="text-xs text-muted-foreground">–</span>
                  <input
                    type="time"
                    value={day.end}
                    disabled={day.off}
                    onChange={e => setDay(key, { end: e.target.value })}
                    className="
                      h-7 rounded-sm border border-input bg-transparent px-1
                      text-xs
                      disabled:opacity-40
                    "
                  />
                </div>
              );
            })}
          </div>
        </div>

        <GrantFields
          modules={modules}
          actions={actions}
          canConfirmTransfers={canConfirmTransfers}
          onToggleModule={(k) => {
            if (k === 'pos' && !modules.pos) {
              setActions(allActionsGranted());
            }
            setModules(p => toggleModuleCascade(p, k));
          }}
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
