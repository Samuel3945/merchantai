'use client';

import type { ActionResult } from '@/libs/action-result';
import { useCallback, useState, useTransition } from 'react';
import {
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
import { ACTION_PERMISSIONS, MODULE_PERMISSIONS } from '@/libs/permissions';
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
  const [employees, setEmployees] = useState(initialEmployees);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<LimitErrorPayload | null>(null);
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

  const handleRevoke = (id: string) => {
    // eslint-disable-next-line no-alert
    if (!globalThis.confirm('¿Revocar esta invitación?')) {
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

  const handleResetPin = (id: string, name: string) => {
    // eslint-disable-next-line no-alert
    if (!globalThis.confirm(`¿Resetear el PIN de ${name}? Quedará sin PIN y podrá configurar uno nuevo desde la caja.`)) {
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
        refresh();
      } catch {
        setError('No se pudo reenviar');
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

      {lastInviteUrl && (
        <div className="
          rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm
          text-emerald-900
        "
        >
          <div className="font-semibold">Enlace de invitación</div>
          <div className="mt-1 text-xs">
            Aún no enviamos correos automáticos: copiá este enlace y pasáselo a
            la persona para que cree su contraseña.
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
                      onClick={() => setLastInviteUrl(inv.inviteUrl)}
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
          onSuccess={(inviteUrl) => {
            setLastInviteUrl(inviteUrl);
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
  onSuccess: (inviteUrl: string) => void;
  onFailure: (failure: ActionFailure) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [modules, setModules] = useState<Record<string, boolean>>({ pos: true });
  const [actions, setActions] = useState<Record<string, boolean>>({});
  const [canConfirmTransfers, setCanConfirmTransfers] = useState(true);
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
      onSuccess(result.data.inviteUrl);
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
          onToggleModule={k => setModules(p => ({ ...p, [k]: !p[k] }))}
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
      const result = await updateEmployee(employee.id, {
        permissions,
        enabledModules,
        canConfirmTransfers,
      });
      if (!result.ok) {
        onFailure(result);
        return;
      }
      onSuccess();
    } catch {
      onFailure({ ok: false, error: 'No se pudieron guardar los permisos' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`Permisos de ${employee.name}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {employee.email}
        </p>

        <GrantFields
          modules={modules}
          actions={actions}
          canConfirmTransfers={canConfirmTransfers}
          onToggleModule={k => setModules(p => ({ ...p, [k]: !p[k] }))}
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
            {submitting ? 'Guardando…' : 'Guardar permisos'}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
