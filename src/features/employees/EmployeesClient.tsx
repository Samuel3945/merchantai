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
} from '@/actions/employees';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { CASHIERS_LIMIT_REACHED } from '@/libs/plan-limits';

type EmployeeRow = Awaited<ReturnType<typeof listEmployees>>[number];
type InvitationRow = Awaited<ReturnType<typeof listPendingInvitations>>[number];
type ActionFailure = Extract<ActionResult<unknown>, { ok: false }>;

const AVAILABLE_PERMISSIONS = [
  { key: 'sales.refund', label: 'Reembolsar ventas' },
  { key: 'cash.withdraw', label: 'Retirar efectivo' },
  { key: 'cash.adjust', label: 'Ajustar conteos de caja' },
  { key: 'inventory.edit', label: 'Editar inventario' },
  { key: 'reports.view', label: 'Ver reportes' },
] as const;

const AVAILABLE_MODULES = [
  { key: 'pos', label: 'POS' },
  { key: 'inventory', label: 'Inventario' },
  { key: 'reports', label: 'Reportes' },
  { key: 'fiados', label: 'Fiados' },
] as const;

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
          <div className="font-semibold">Límite de cajeros alcanzado</div>
          <div>
            El plan
            {' '}
            <span className="font-mono">{limitError.plan}</span>
            {' '}
            permite
            {' '}
            {limitError.base}
            {' '}
            cajeros (+
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
        <div className="text-lg font-semibold">Empleados</div>
        <Button
          onClick={() => setShowInviteModal(true)}
          disabled={pending}
        >
          Invitar empleado
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Nombre</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Rol</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Módulos</th>
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
                  colSpan={8}
                >
                  Aún no hay empleados
                </td>
              </tr>
            )}
            {employees.map(emp => (
              <tr key={emp.id} className="border-t">
                <td className="px-3 py-2">{emp.name}</td>
                <td className="px-3 py-2">{emp.email}</td>
                <td className="px-3 py-2">{emp.role}</td>
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
                <td className="px-3 py-2">
                  {emp.hasPin && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleResetPin(emp.id, emp.name)}
                      disabled={pending}
                      title="Deja al empleado sin PIN para que configure uno nuevo"
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
                <th className="px-3 py-2">Rol</th>
                <th className="px-3 py-2">Vence</th>
                <th className="px-3 py-2">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {invitations.length === 0 && (
                <tr>
                  <td
                    className="px-3 py-6 text-center text-muted-foreground"
                    colSpan={5}
                  >
                    No hay invitaciones pendientes
                  </td>
                </tr>
              )}
              {invitations.map(inv => (
                <tr key={inv.id} className="border-t">
                  <td className="px-3 py-2">{inv.email}</td>
                  <td className="px-3 py-2">{inv.name}</td>
                  <td className="px-3 py-2">{inv.role}</td>
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
          onFailure={(failure) => {
            const limit = limitPayload(failure);
            if (limit) {
              setLimitError(limit);
            } else {
              setError(failure.error);
            }
          }}
        />
      )}
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
  const [role, setRole] = useState<'admin' | 'cashier' | 'employee'>('cashier');
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [modules, setModules] = useState<Record<string, boolean>>({
    pos: true,
  });
  const [canConfirmTransfers, setCanConfirmTransfers] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const togglePerm = (key: string) =>
    setPermissions(prev => ({ ...prev, [key]: !prev[key] }));
  const toggleModule = (key: string) =>
    setModules(prev => ({ ...prev, [key]: !prev[key] }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const enabledModules = Object.entries(modules)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const cleanPerms = Object.fromEntries(
        Object.entries(permissions).filter(([, v]) => v),
      );
      const result = await invite({
        email,
        name,
        role,
        permissions: cleanPerms,
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
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="w-full max-w-lg rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Invitar empleado</h2>
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
            <label htmlFor="emp-role" className={labelCls}>
              Rol
            </label>
            <Select
              id="emp-role"
              value={role}
              onValueChange={v =>
                setRole(v as 'admin' | 'cashier' | 'employee')}
              options={[
                { value: 'cashier', label: 'Cajero' },
                { value: 'employee', label: 'Empleado' },
                { value: 'admin', label: 'Administrador' },
              ]}
            />
          </div>

          <div>
            <div className={labelCls}>Permisos</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {AVAILABLE_PERMISSIONS.map(p => (
                <label key={p.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!permissions[p.key]}
                    onChange={() => togglePerm(p.key)}
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className={labelCls}>Módulos habilitados</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {AVAILABLE_MODULES.map(m => (
                <label key={m.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!modules[m.key]}
                    onChange={() => toggleModule(m.key)}
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={canConfirmTransfers}
              onChange={() => setCanConfirmTransfers(v => !v)}
            />
            Puede confirmar transferencias
          </label>

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
              {submitting ? 'Enviando…' : 'Enviar invitación'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
