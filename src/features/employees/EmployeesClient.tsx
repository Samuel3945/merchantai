'use client';

import { useCallback, useState, useTransition } from 'react';
import {
  invite,
  listEmployees,
  listPendingInvitations,
  resendInvitation,
  revokeInvitation,
} from '@/actions/employees';
import { Button } from '@/components/ui/button';

type EmployeeRow = Awaited<ReturnType<typeof listEmployees>>[number];
type InvitationRow = Awaited<ReturnType<typeof listPendingInvitations>>[number];

const AVAILABLE_PERMISSIONS = [
  { key: 'sales.refund', label: 'Refund sales' },
  { key: 'cash.withdraw', label: 'Withdraw cash' },
  { key: 'cash.adjust', label: 'Adjust cash counts' },
  { key: 'inventory.edit', label: 'Edit inventory' },
  { key: 'reports.view', label: 'View reports' },
] as const;

const AVAILABLE_MODULES = [
  { key: 'pos', label: 'POS' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'reports', label: 'Reports' },
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

function parseLimitError(err: unknown): LimitErrorPayload | null {
  if (!err) {
    return null;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/\{[^}]*cashiers_limit_reached[^}]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as LimitErrorPayload;
    } catch {
      // fall through
    }
  }
  if (msg.includes('Cashiers limit reached')) {
    return {
      code: 'cashiers_limit_reached',
      plan: '',
      limit: 0,
      used: 0,
      base: 0,
      addons: 0,
    };
  }
  return null;
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
    if (!globalThis.confirm('Revoke this invitation?')) {
      return;
    }
    startTransition(async () => {
      try {
        await revokeInvitation(id);
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to revoke');
      }
    });
  };

  const handleResend = (id: string) => {
    startTransition(async () => {
      try {
        const res = await resendInvitation(id);
        setLastInviteUrl(res.inviteUrl);
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to resend');
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
            Dismiss
          </button>
        </div>
      )}

      {limitError && (
        <div className="
          rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm
          text-amber-900
        "
        >
          <div className="font-semibold">Cashier limit reached</div>
          <div>
            Plan
            {' '}
            <span className="font-mono">{limitError.plan}</span>
            {' '}
            allows
            {' '}
            {limitError.base}
            {' '}
            cashiers (+
            {limitError.addons}
            {' '}
            add-on
            {limitError.addons === 1 ? '' : 's'}
            ) =
            {' '}
            {limitError.limit}
            . Currently used:
            {' '}
            {limitError.used}
            .
          </div>
          <button
            type="button"
            className="mt-1 underline"
            onClick={() => setLimitError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {lastInviteUrl && (
        <div className="
          rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm
          text-emerald-900
        "
        >
          <div className="font-semibold">Invitation link</div>
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
            Copy
          </button>
          <button
            type="button"
            className="mt-2 ml-3 underline"
            onClick={() => setLastInviteUrl(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Employees</div>
        <Button
          onClick={() => setShowInviteModal(true)}
          disabled={pending}
        >
          Invite employee
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Modules</th>
              <th className="px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 && (
              <tr>
                <td
                  className="px-3 py-6 text-center text-muted-foreground"
                  colSpan={6}
                >
                  No employees yet
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
                        <span className="text-emerald-700">active</span>
                      )
                    : (
                        <span className="text-muted-foreground">inactive</span>
                      )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {(emp.enabledModules ?? []).join(', ') || '—'}
                </td>
                <td className="px-3 py-2 text-xs">
                  {formatDate(emp.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="mb-3 text-lg font-semibold">Pending invitations</div>
        <div className="overflow-x-auto rounded-md border bg-background">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase">
              <tr>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Expires</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invitations.length === 0 && (
                <tr>
                  <td
                    className="px-3 py-6 text-center text-muted-foreground"
                    colSpan={5}
                  >
                    No pending invitations
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
                      <span className="ml-2 text-destructive">(expired)</span>
                    )}
                  </td>
                  <td className="space-x-2 px-3 py-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleResend(inv.id)}
                      disabled={pending}
                    >
                      Resend
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleRevoke(inv.id)}
                      disabled={pending}
                    >
                      Revoke
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setLastInviteUrl(inv.inviteUrl)}
                    >
                      Show link
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
          onError={(err) => {
            const limit = parseLimitError(err);
            if (limit) {
              setLimitError(limit);
            } else {
              setError(err instanceof Error ? err.message : String(err));
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
  onError,
}: {
  onClose: () => void;
  onSuccess: (inviteUrl: string) => void;
  onError: (err: unknown) => void;
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
      const res = await invite({
        email,
        name,
        role,
        permissions: cleanPerms,
        enabledModules,
        canConfirmTransfers,
      });
      onSuccess(res.inviteUrl);
    } catch (err) {
      onError(err);
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
          <h2 className="text-lg font-semibold">Invite employee</h2>
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
              Name
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
              Role
            </label>
            <select
              id="emp-role"
              value={role}
              onChange={e =>
                setRole(e.target.value as 'admin' | 'cashier' | 'employee')}
              className={inputCls}
            >
              <option value="cashier">Cashier</option>
              <option value="employee">Employee</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          <div>
            <div className={labelCls}>Permissions</div>
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
            <div className={labelCls}>Enabled modules</div>
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
            Can confirm transfers
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send invitation'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
