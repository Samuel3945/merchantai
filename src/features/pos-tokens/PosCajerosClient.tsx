'use client';

import type {
  listOrgCashiers,
  PosDeviceQuota,
} from '@/actions/pos-tokens';
import {
  ArrowUpRight,
  CheckCircle2,
  ExternalLink,
  Lock,
  Monitor,
  Plus,
} from 'lucide-react';
import { useCallback, useState, useTransition } from 'react';
import {
  createPosToken,
  forceLogoutPosToken,
  getPosDeviceQuota,
  listPosTokens,
  regeneratePosToken,
  revokePosToken,
} from '@/actions/pos-tokens';
import { Button } from '@/components/ui/button';
import { Link } from '@/libs/I18nNavigation';

/**
 * App de cajero en producción (repo `pos-merchatai`, dominio propio).
 * Abrirla desde aquí sirve para verificar de punta a punta que el dispositivo
 * de caja levanta y se conecta a su backend (este MerchantAI vía /api/pos/*).
 */
const TIENDA_CAJERO_URL = 'https://app.pos.mymerchantai.com';

type TokenRow = Awaited<ReturnType<typeof listPosTokens>>[number];
type CashierRow = Awaited<ReturnType<typeof listOrgCashiers>>[number];

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-xs font-medium text-muted-foreground';

const PLAN_LABEL: Record<string, string> = {
  free: 'Gratis',
  starter: 'Starter',
  pro: 'Pro',
  business: 'Business',
};

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

function formatDate(date: Date | string | null | undefined) {
  if (!date) {
    return '—';
  }
  return dateFmt.format(new Date(date));
}

function qrUrl(text: string, size = 220) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;
}

type LimitErrorPayload = {
  code: 'pos_devices_limit_reached';
  plan: string;
  limit: number;
  used: number;
  base: number;
  addons: number;
};

// The server action throws an Error whose message embeds a JSON blob; we parse
// it back out so the client can render the upgrade CTA with real numbers.
function parseLimitError(err: unknown): LimitErrorPayload | null {
  if (!err) {
    return null;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/\{[^}]*pos_devices_limit_reached[^}]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as LimitErrorPayload;
    } catch {
      // fall through
    }
  }
  if (msg.includes('Pos devices limit reached')) {
    return { code: 'pos_devices_limit_reached', plan: '', limit: 0, used: 0, base: 0, addons: 0 };
  }
  return null;
}

export function PosCajerosClient({
  initialTokens,
  initialCashiers,
  initialQuota,
}: {
  initialTokens: TokenRow[];
  initialCashiers: CashierRow[];
  initialQuota: PosDeviceQuota;
}) {
  const [tokens, setTokens] = useState(initialTokens);
  const [cashiers] = useState(initialCashiers);
  const [quota, setQuota] = useState(initialQuota);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [activeToken, setActiveToken] = useState<TokenRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<LimitErrorPayload | null>(null);
  const [pending, startTransition] = useTransition();

  const atLimit = quota.used >= quota.limit;
  const usagePct = quota.limit > 0
    ? Math.min(100, Math.round((quota.used / quota.limit) * 100))
    : 100;

  const refresh = useCallback(() => {
    startTransition(async () => {
      const [rows, q] = await Promise.all([listPosTokens(), getPosDeviceQuota()]);
      setTokens(rows);
      setQuota(q);
    });
  }, []);

  const handleOpenCreate = () => {
    if (atLimit) {
      setLimitError({
        code: 'pos_devices_limit_reached',
        plan: quota.plan,
        limit: quota.limit,
        used: quota.used,
        base: quota.base,
        addons: quota.addons,
      });
      return;
    }
    setLimitError(null);
    setShowCreateModal(true);
  };

  const handleRevoke = (id: string) => {
    // eslint-disable-next-line no-alert
    if (!globalThis.confirm('¿Revocar esta caja? El dispositivo dejará de sincronizar y el slot quedará libre.')) {
      return;
    }
    startTransition(async () => {
      try {
        await revokePosToken(id);
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo revocar');
      }
    });
  };

  const handleRegenerate = (id: string) => {
    // eslint-disable-next-line no-alert
    if (!globalThis.confirm('¿Cambiar el acceso de esta caja? El dispositivo actual deberá escanear el código nuevo para volver a entrar.')) {
      return;
    }
    startTransition(async () => {
      try {
        const updated = await regeneratePosToken(id);
        const rows = await listPosTokens();
        setTokens(rows);
        const fresh = rows.find(r => r.id === updated.id);
        if (fresh) {
          setActiveToken(fresh);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo regenerar el acceso');
      }
    });
  };

  const handleForceLogout = (id: string) => {
    // eslint-disable-next-line no-alert
    if (!globalThis.confirm('¿Cerrar la sesión de esta caja? El empleado activo tendrá que volver a ingresar su PIN (la caja sigue activa).')) {
      return;
    }
    startTransition(async () => {
      try {
        await forceLogoutPosToken(id);
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo cerrar la sesión');
      }
    });
  };

  return (
    <div className="space-y-6">
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
        <LimitBanner
          payload={limitError}
          onDismiss={() => setLimitError(null)}
        />
      )}

      <QuotaCard quota={quota} usagePct={usagePct} atLimit={atLimit} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-lg font-semibold">Tus cajas</div>
          <p className="text-sm text-muted-foreground">
            Cada caja es un dispositivo (tablet, celular o PC) que abre el POS y
            sincroniza con tu negocio.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <a
              href={TIENDA_CAJERO_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-4" />
              Abrir POS
            </a>
          </Button>
          {atLimit
            ? (
                <Button asChild>
                  <Link href="/dashboard/plans">
                    <Lock className="size-4" />
                    Desbloquear más cajas
                  </Link>
                </Button>
              )
            : (
                <Button onClick={handleOpenCreate} disabled={pending}>
                  <Plus className="size-4" />
                  Agregar caja
                </Button>
              )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Caja / dispositivo</th>
              <th className="px-3 py-2">Cajero</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Último sync</th>
              <th className="px-3 py-2">Expira</th>
              <th className="px-3 py-2">Creada</th>
              <th className="px-3 py-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {tokens.length === 0 && (
              <tr>
                <td
                  className="px-3 py-8 text-center text-muted-foreground"
                  colSpan={7}
                >
                  Aún no tienes cajas. Agrega una para registrar tu primer
                  dispositivo POS.
                </td>
              </tr>
            )}
            {tokens.map(t => (
              <tr key={t.id} className="border-t">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Monitor className="size-4 text-muted-foreground" />
                    {t.deviceName}
                  </div>
                </td>
                <td className="px-3 py-2">{t.cashierName ?? '—'}</td>
                <td className="px-3 py-2">
                  {t.active
                    ? (
                        <span className="
                          inline-flex items-center gap-1 rounded-full
                          bg-emerald-50 px-2 py-0.5 text-xs font-medium
                          text-emerald-700
                        "
                        >
                          <CheckCircle2 className="size-3" />
                          Activa
                        </span>
                      )
                    : (
                        <span className="
                          inline-flex items-center rounded-full bg-muted px-2
                          py-0.5 text-xs font-medium text-muted-foreground
                        "
                        >
                          Revocada
                        </span>
                      )}
                </td>
                <td className="px-3 py-2 text-xs">{formatDate(t.lastSyncAt)}</td>
                <td className="px-3 py-2 text-xs">{formatDate(t.expiresAt)}</td>
                <td className="px-3 py-2 text-xs">{formatDate(t.createdAt)}</td>
                <td className="space-x-2 px-3 py-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setActiveToken(t)}
                  >
                    Ver acceso
                  </Button>
                  {t.active && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleForceLogout(t.id)}
                        disabled={pending}
                        title="Desloguea al empleado activo; la caja sigue activa"
                      >
                        Cerrar sesión
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleRegenerate(t.id)}
                        disabled={pending}
                        title="Genera un acceso nuevo; el dispositivo deberá escanearlo"
                      >
                        Cambiar acceso
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleRevoke(t.id)}
                        disabled={pending}
                      >
                        Revocar
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreateModal && (
        <CreateTokenModal
          cashiers={cashiers}
          onClose={() => setShowCreateModal(false)}
          onSuccess={(created) => {
            setShowCreateModal(false);
            setActiveToken({
              id: created.id,
              token: created.token,
              storeId: created.storeId,
              deviceName: created.deviceName,
              createdBy: created.createdBy,
              cashierId: created.cashierId,
              cashierName:
                cashiers.find(c => c.id === created.cashierId)?.name ?? null,
              active: created.active,
              lastSyncAt: created.lastSyncAt,
              expiresAt: created.expiresAt,
              createdAt: created.createdAt,
            });
            refresh();
          }}
          onError={(err) => {
            const limit = parseLimitError(err);
            if (limit) {
              setShowCreateModal(false);
              setLimitError(limit);
              return;
            }
            setError(err instanceof Error ? err.message : String(err));
          }}
        />
      )}

      {activeToken && (
        <QrModal token={activeToken} onClose={() => setActiveToken(null)} />
      )}
    </div>
  );
}

function QuotaCard({
  quota,
  usagePct,
  atLimit,
}: {
  quota: PosDeviceQuota;
  usagePct: number;
  atLimit: boolean;
}) {
  const planLabel = PLAN_LABEL[quota.plan] ?? quota.plan;
  const barColor = atLimit
    ? 'bg-amber-500'
    : usagePct >= 80
      ? 'bg-amber-400'
      : 'bg-emerald-500';

  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">
              Cajas activas
            </span>
            <span className="
              rounded-full bg-muted px-2 py-0.5 text-xs font-medium
            "
            >
              Plan
              {' '}
              {planLabel}
            </span>
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {quota.used}
            {' '}
            <span className="text-base font-normal text-muted-foreground">
              /
              {' '}
              {quota.limit}
            </span>
          </div>
          {quota.addons > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {quota.base}
              {' '}
              del plan +
              {' '}
              {quota.addons}
              {' '}
              adicional
              {quota.addons === 1 ? '' : 'es'}
            </p>
          )}
        </div>

        {atLimit
          ? (
              <Button asChild size="sm">
                <Link href="/dashboard/plans">
                  Desbloquear más cajas
                  <ArrowUpRight className="size-4" />
                </Link>
              </Button>
            )
          : (
              <span className="text-sm text-emerald-700">
                {quota.remaining}
                {' '}
                disponible
                {quota.remaining === 1 ? '' : 's'}
              </span>
            )}
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`
            h-full rounded-full transition-all
            ${barColor}
          `}
          style={{ width: `${usagePct}%` }}
        />
      </div>

      {atLimit && (
        <p className="mt-2 text-xs text-amber-700">
          Llegaste al máximo de cajas de tu plan. Mejora tu plan o suma una caja
          adicional para registrar otro dispositivo.
        </p>
      )}
    </div>
  );
}

function LimitBanner({
  payload,
  onDismiss,
}: {
  payload: LimitErrorPayload;
  onDismiss: () => void;
}) {
  const planLabel = PLAN_LABEL[payload.plan] ?? payload.plan;
  return (
    <div className="
      rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm
      text-amber-900
    "
    >
      <div className="flex items-center gap-2 font-semibold">
        <Lock className="size-4" />
        Límite de cajas alcanzado
      </div>
      <div className="mt-1">
        {payload.plan
          ? (
              <>
                El plan
                {' '}
                <span className="font-medium">{planLabel}</span>
                {' '}
                permite
                {' '}
                {payload.base}
                {' '}
                caja
                {payload.base === 1 ? '' : 's'}
                {payload.addons > 0 && (
                  <>
                    {' '}
                    (+
                    {payload.addons}
                    {' '}
                    adicional
                    {payload.addons === 1 ? '' : 'es'}
                    )
                  </>
                )}
                {' = '}
                {payload.limit}
                . En uso:
                {' '}
                {payload.used}
                .
              </>
            )
          : 'Alcanzaste el máximo de cajas de tu plan.'}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Button asChild size="sm">
          <Link href="/dashboard/plans">
            Ver planes y desbloquear
            <ArrowUpRight className="size-4" />
          </Link>
        </Button>
        <button type="button" className="underline" onClick={onDismiss}>
          Descartar
        </button>
      </div>
    </div>
  );
}

function CreateTokenModal({
  cashiers,
  onClose,
  onSuccess,
  onError,
}: {
  cashiers: CashierRow[];
  onClose: () => void;
  onSuccess: (token: Awaited<ReturnType<typeof createPosToken>>) => void;
  onError: (err: unknown) => void;
}) {
  const [deviceName, setDeviceName] = useState('');
  const [cashierId, setCashierId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const created = await createPosToken({
        deviceName,
        cashierId: cashierId || undefined,
        expiresAt: expiresAt || undefined,
      });
      onSuccess(created);
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
          <h2 className="text-lg font-semibold">Nueva caja</h2>
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
            <label htmlFor="pt-device" className={labelCls}>
              Nombre de la caja / dispositivo
            </label>
            <input
              id="pt-device"
              type="text"
              required
              placeholder="Caja 1 - tablet mostrador"
              value={deviceName}
              onChange={e => setDeviceName(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="pt-cashier" className={labelCls}>
              Cajero asignado (opcional)
            </label>
            <select
              id="pt-cashier"
              value={cashierId}
              onChange={e => setCashierId(e.target.value)}
              className={inputCls}
            >
              <option value="">— Sin asignar —</option>
              {cashiers.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {' '}
                  (
                  {c.email}
                  )
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="pt-expires" className={labelCls}>
              Expira (opcional)
            </label>
            <input
              id="pt-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={e => setExpiresAt(e.target.value)}
              className={inputCls}
            />
          </div>

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
              {submitting ? 'Creando…' : 'Crear caja'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function QrModal({
  token,
  onClose,
}: {
  token: TokenRow;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
      setTimeout(setCopied, 1500, false);
    } catch {
      // ignore
    }
  };

  return (
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{token.deviceName}</h2>
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

        <ol className="
          mb-4 list-decimal space-y-1 rounded-md bg-muted/40 py-3 pr-3 pl-8
          text-xs text-muted-foreground
        "
        >
          <li>
            Abre
            {' '}
            <span className="font-medium text-foreground">{TIENDA_CAJERO_URL.replace('https://', '')}</span>
            {' '}
            en el dispositivo de la caja.
          </li>
          <li>Escanea el código QR o pega el código de acceso.</li>
          <li>La caja queda vinculada y empieza a sincronizar.</li>
        </ol>

        <div className="flex flex-col items-center gap-4">
          {/* eslint-disable-next-line next/no-img-element */}
          <img
            src={qrUrl(token.token)}
            alt={`Código de acceso de ${token.deviceName}`}
            width={220}
            height={220}
            className="rounded-md border bg-white p-2"
          />

          <div className="w-full">
            <div className={labelCls}>Código de acceso</div>
            <div className="
              mt-1 rounded-md border bg-muted/40 p-2 font-mono text-xs break-all
            "
            >
              {token.token}
            </div>
          </div>

          <div className="flex w-full justify-end gap-2">
            <Button variant="secondary" onClick={handleCopy}>
              {copied ? 'Copiado ✓' : 'Copiar código'}
            </Button>
            <Button onClick={onClose}>Cerrar</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
