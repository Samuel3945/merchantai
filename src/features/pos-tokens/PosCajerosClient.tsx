'use client';

import type { ArchivedCaja, CajaConfig } from '@/actions/cajas';
import type { PosDeviceQuota } from '@/actions/pos-tokens';
import type { ActionResult } from '@/libs/action-result';
import {
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ExternalLink,
  Lock,
  Monitor,
  MoreVertical,
  PackageX,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  Split,
  Unlock,
  UserCog,
  Users,
  Vault,
  Wallet,
} from 'lucide-react';
import { useCallback, useState, useTransition } from 'react';
import {
  assignDeviceToCaja,
  listArchivedCajas,
  listCajas,
  splitDeviceToOwnCaja,
} from '@/actions/cajas';
import {
  blockPosToken,
  createPosToken,
  forceLogoutPosToken,
  getPosDeviceQuota,
  listPosTokens,
  regeneratePosToken,
  renamePosToken,
  setAdminAsCashier,
  setPosTokenAllowOversell,
  setPosTokenSweepDestination,
  unblockPosToken,
} from '@/actions/pos-tokens';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link } from '@/libs/I18nNavigation';
import { POS_DEVICES_LIMIT_REACHED } from '@/libs/plan-limits';

/**
 * App de cajero en producción (repo `pos-merchatai`, dominio propio).
 * Abrirla desde aquí sirve para verificar de punta a punta que el dispositivo
 * de caja levanta y se conecta a su backend (este MerchantAI vía /api/pos/*).
 */
const TIENDA_CAJERO_URL = 'https://app.pos.mymerchantai.com';

type TokenRow = Awaited<ReturnType<typeof listPosTokens>>[number];
type CofreOption = { id: string; name: string };
type CreatedToken = Extract<
  Awaited<ReturnType<typeof createPosToken>>,
  { ok: true }
>['data'];
type ActionFailure = Extract<ActionResult<unknown>, { ok: false }>;

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

const dayFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeZone: 'America/Bogota',
});

function formatDay(date: Date | string | null | undefined) {
  if (!date) {
    return '—';
  }
  return dayFmt.format(new Date(date));
}

function qrUrl(text: string, size = 220) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;
}

// The QR encodes a deep link into the POS app, not the raw token. Scanned from
// the POS's built-in scanner it prefills the access code (only the PIN is left);
// scanned with a regular phone camera it opens the POS web app directly.
function accessLink(token: string) {
  return `${TIENDA_CAJERO_URL}/?code=${encodeURIComponent(token)}`;
}

type LimitErrorPayload = {
  code: 'pos_devices_limit_reached';
  plan: string;
  limit: number;
  used: number;
  base: number;
  addons: number;
};

// A coded failure result carries the real numbers in `meta`, so the client can
// render the upgrade CTA. Returns null when the failure isn't a limit error.
function limitPayload(failure: ActionFailure): LimitErrorPayload | null {
  if (failure.code !== POS_DEVICES_LIMIT_REACHED) {
    return null;
  }
  const meta = failure.meta ?? {};
  return {
    code: 'pos_devices_limit_reached',
    plan: String(meta.plan ?? ''),
    limit: Number(meta.limit ?? 0),
    used: Number(meta.used ?? 0),
    base: Number(meta.base ?? 0),
    addons: Number(meta.addons ?? 0),
  };
}

export function PosCajerosClient({
  initialTokens,
  initialQuota,
  initialCofres,
  initialCajas,
  initialArchivedCajas,
}: {
  initialTokens: TokenRow[];
  initialQuota: PosDeviceQuota;
  initialCofres: CofreOption[];
  initialCajas: CajaConfig[];
  initialArchivedCajas: ArchivedCaja[];
}) {
  const confirm = useConfirm();
  const [tokens, setTokens] = useState(initialTokens);
  const [quota, setQuota] = useState(initialQuota);
  const [cofres] = useState(initialCofres);
  const [cajas, setCajas] = useState(initialCajas);
  const [archivedCajas, setArchivedCajas] = useState(initialArchivedCajas);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [activeToken, setActiveToken] = useState<TokenRow | null>(null);
  const [renameTarget, setRenameTarget] = useState<TokenRow | null>(null);
  const [sweepTarget, setSweepTarget] = useState<TokenRow | null>(null);
  const [cajaTarget, setCajaTarget] = useState<TokenRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<LimitErrorPayload | null>(null);
  const [pending, startTransition] = useTransition();

  const atLimit = quota.used >= quota.limit;

  // Solo las cajas 'register' (bolsas de POS) participan del compartir/separar.
  const registerCajas = cajas.filter(c => c.type === 'register');
  // deviceId → caja a la que pertenece, para pintar la bolsa de cada dispositivo.
  const cajaByDevice = new Map<string, CajaConfig>();
  for (const caja of registerCajas) {
    for (const d of caja.devices) {
      cajaByDevice.set(d.id, caja);
    }
  }

  const refresh = useCallback(() => {
    startTransition(async () => {
      const [rows, q, overview, archived] = await Promise.all([
        listPosTokens(),
        getPosDeviceQuota(),
        listCajas().catch(() => ({ cajas: [], couriersWithoutCaja: [] })),
        listArchivedCajas().catch(() => []),
      ]);
      setTokens(rows);
      setQuota(q);
      setCajas(overview.cajas);
      setArchivedCajas(archived);
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

  const handleBlock = (id: string) => {
    startTransition(async () => {
      try {
        const result = await blockPosToken(id);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        refresh();
      } catch {
        setError('No se pudo bloquear');
      }
    });
  };

  const handleUnblock = (id: string) => {
    startTransition(async () => {
      try {
        const result = await unblockPosToken(id);
        if (!result.ok) {
          const limit = limitPayload(result);
          if (limit) {
            setLimitError(limit);
            return;
          }
          setError(result.error);
          return;
        }
        refresh();
      } catch {
        setError('No se pudo desbloquear');
      }
    });
  };

  const handleToggleOversell = (t: TokenRow) => {
    startTransition(async () => {
      try {
        const result = await setPosTokenAllowOversell(t.id, !t.allowOversell);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        refresh();
      } catch {
        setError('No se pudo cambiar el control de stock');
      }
    });
  };

  // Toggle "el admin hace de cajero" for this caja: ON (cashier_id set) → the
  // admin is the default responsable; OFF (null) → each cashier employee
  // identifies themselves. Turning it OFF is rejected by the server when no
  // cashier employee exists, so the caja is never left without a responsable.
  const handleToggleAdminCashier = (t: TokenRow) => {
    startTransition(async () => {
      try {
        const result = await setAdminAsCashier(t.id, t.cashierId == null);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        refresh();
      } catch {
        setError('No se pudo cambiar quién hace de cajero');
      }
    });
  };

  const handleRegenerate = async (id: string) => {
    const ok = await confirm({
      title: '¿Cambiar el acceso de esta caja?',
      description:
        'El dispositivo actual deberá escanear el código nuevo para volver a entrar.',
      confirmText: 'Cambiar acceso',
    });
    if (!ok) {
      return;
    }
    startTransition(async () => {
      try {
        const result = await regeneratePosToken(id);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        const rows = await listPosTokens();
        setTokens(rows);
        const fresh = rows.find(r => r.id === result.data.id);
        if (fresh) {
          setActiveToken(fresh);
        }
      } catch {
        setError('No se pudo regenerar el acceso');
      }
    });
  };

  const handleForceLogout = async (id: string) => {
    const ok = await confirm({
      title: '¿Cerrar la sesión de esta caja?',
      description:
        'El empleado activo tendrá que volver a ingresar su PIN. La caja sigue activa.',
      confirmText: 'Cerrar sesión',
    });
    if (!ok) {
      return;
    }
    startTransition(async () => {
      try {
        const result = await forceLogoutPosToken(id);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        refresh();
      } catch {
        setError('No se pudo cerrar la sesión');
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
          <Button onClick={handleOpenCreate} disabled={pending}>
            <Plus className="size-4" />
            Agregar caja
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Caja / dispositivo</th>
              <th className="px-3 py-2">Bolsa de dinero</th>
              <th className="px-3 py-2">Cajero</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Creada</th>
              <th className="px-3 py-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {tokens.length === 0 && (
              <tr>
                <td
                  className="px-3 py-8 text-center text-muted-foreground"
                  colSpan={6}
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
                <td className="px-3 py-2">
                  <CajaBadge caja={cajaByDevice.get(t.id) ?? null} />
                </td>
                <td className="px-3 py-2">
                  {t.currentCashierName
                    ? (
                        <div className="flex flex-col items-start">
                          <span>{t.currentCashierName}</span>
                          {t.currentCashierAt && (
                            <span className="text-xs text-muted-foreground">
                              desde
                              {' '}
                              {formatDate(t.currentCashierAt)}
                            </span>
                          )}
                        </div>
                      )
                    : (
                        <span className="text-muted-foreground">—</span>
                      )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col items-start gap-1">
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
                            inline-flex items-center gap-1 rounded-full
                            bg-amber-50 px-2 py-0.5 text-xs font-medium
                            text-amber-700
                          "
                          >
                            <Ban className="size-3" />
                            Bloqueada
                          </span>
                        )}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">{formatDate(t.createdAt)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setActiveToken(t)}
                    >
                      <QrCode className="size-4" />
                      Ver acceso
                    </Button>
                    {t.active
                      ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleBlock(t.id)}
                            disabled={pending}
                            title="Bloquea la caja; deja de sincronizar pero no se borra"
                          >
                            <Ban className="size-4" />
                            Bloquear
                          </Button>
                        )
                      : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleUnblock(t.id)}
                            disabled={pending}
                            title="Reactiva la caja (revalida el cupo de tu plan)"
                          >
                            <Unlock className="size-4" />
                            Desbloquear
                          </Button>
                        )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={pending}
                          aria-label="Más opciones"
                        >
                          <MoreVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onClick={() => setRenameTarget(t)}>
                          <Pencil className="size-4" />
                          Cambiar nombre
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setCajaTarget(t)}>
                          <Wallet className="size-4" />
                          Bolsa de dinero
                        </DropdownMenuItem>
                        {cofres.length > 0 && (
                          <DropdownMenuItem onClick={() => setSweepTarget(t)}>
                            <Vault className="size-4" />
                            Destino de barrido
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() => handleToggleOversell(t)}
                        >
                          <PackageX className="size-4" />
                          {t.allowOversell
                            ? 'Exigir stock para vender'
                            : 'Vender sin control de stock'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleToggleAdminCashier(t)}
                        >
                          <UserCog className="size-4" />
                          {t.cashierId
                            ? 'Quitar al admin como cajero'
                            : 'Poner al admin como cajero'}
                        </DropdownMenuItem>
                        {t.active && (
                          <>
                            <DropdownMenuItem
                              onClick={() => handleRegenerate(t.id)}
                            >
                              <RefreshCw className="size-4" />
                              Cambiar acceso
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleForceLogout(t.id)}
                            >
                              <Unlock className="size-4" />
                              Cerrar sesión
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreateModal && (
        <CreateTokenModal
          registerCajas={registerCajas}
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
              currentCashierId: created.currentCashierId,
              currentCashierName: null,
              currentCashierAt: created.currentCashierAt,
              addressId: created.addressId,
              addressName: null,
              address: null,
              addressCity: null,
              active: created.active,
              allowOversell: created.allowOversell,
              cashMode: created.cashMode,
              createdAt: created.createdAt,
              defaultSweepDestinationAccountId: null,
            });
            refresh();
          }}
          onFailure={(failure) => {
            const limit = limitPayload(failure);
            if (limit) {
              setShowCreateModal(false);
              setLimitError(limit);
              return;
            }
            setError(failure.error);
          }}
        />
      )}

      {activeToken && (
        <QrModal token={activeToken} onClose={() => setActiveToken(null)} />
      )}

      {renameTarget && (
        <RenameModal
          token={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSaved={() => {
            setRenameTarget(null);
            refresh();
          }}
          onError={msg => setError(msg)}
        />
      )}

      {sweepTarget && (
        <SweepDestinationModal
          token={sweepTarget}
          cofres={cofres}
          onClose={() => setSweepTarget(null)}
          onSaved={() => {
            setSweepTarget(null);
            refresh();
          }}
          onError={msg => setError(msg)}
        />
      )}

      {cajaTarget && (
        <CajaManageModal
          token={cajaTarget}
          caja={cajaByDevice.get(cajaTarget.id) ?? null}
          otherCajas={registerCajas.filter(
            c => c.id !== cajaByDevice.get(cajaTarget.id)?.id,
          )}
          pending={pending}
          onClose={() => setCajaTarget(null)}
          onShare={cajaId =>
            startTransition(async () => {
              try {
                const r = await assignDeviceToCaja(cajaTarget.id, cajaId);
                if (!r.ok) {
                  setError(r.error);
                  return;
                }
                setCajaTarget(null);
                refresh();
              } catch {
                setError('No se pudo compartir la bolsa de dinero');
              }
            })}
          onSplit={() =>
            startTransition(async () => {
              try {
                const r = await splitDeviceToOwnCaja(cajaTarget.id);
                if (!r.ok) {
                  setError(r.error);
                  return;
                }
                setCajaTarget(null);
                refresh();
              } catch {
                setError('No se pudo separar la bolsa de dinero');
              }
            })}
        />
      )}

      <ArchivedCajasSection cajas={archivedCajas} />
    </div>
  );
}

// Etiqueta de la bolsa de dinero (caja) de un dispositivo: compartida (2+
// pantallas) o individual. Sin caja = estado transitorio recién creado.
function CajaBadge({ caja }: { caja: CajaConfig | null }) {
  if (!caja) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const shared = caja.isShared;
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="text-sm">{caja.name}</span>
      <span className={`
        inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs
        font-medium
        ${shared ? 'bg-sky-50 text-sky-700' : 'bg-violet-50 text-violet-700'}
      `}
      >
        {shared
          ? (
              <>
                <Users className="size-3" />
                Compartida ·
                {' '}
                {caja.devices.length}
                {' '}
                pantallas
              </>
            )
          : (
              <>
                <Monitor className="size-3" />
                Individual
              </>
            )}
      </span>
    </div>
  );
}

// Historial de cajas archivadas: cada una con su ventana "del {creación} al
// {archivado}". Colapsable para no robar espacio; oculto si no hay ninguna.
function ArchivedCajasSection({ cajas }: { cajas: ArchivedCaja[] }) {
  if (cajas.length === 0) {
    return null;
  }
  return (
    <details className="rounded-md border bg-background">
      <summary className="
        cursor-pointer px-4 py-2 text-sm font-medium text-muted-foreground
        select-none
      "
      >
        Cajas archivadas (
        {cajas.length}
        )
      </summary>
      <ul className="divide-y border-t text-sm">
        {cajas.map(c => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-2 px-4 py-2"
          >
            <span className="flex items-center gap-2">
              <Wallet className="size-4 text-muted-foreground" />
              {c.name}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              del
              {' '}
              {formatDay(c.createdAt)}
              {' '}
              al
              {' '}
              {formatDay(c.archivedAt)}
            </span>
          </li>
        ))}
      </ul>
    </details>
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
  registerCajas,
  onClose,
  onSuccess,
  onFailure,
}: {
  registerCajas: CajaConfig[];
  onClose: () => void;
  onSuccess: (token: CreatedToken) => void;
  onFailure: (failure: ActionFailure) => void;
}) {
  const [deviceName, setDeviceName] = useState('');
  const [adminPin, setAdminPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Solo el 2º+ dispositivo elige bolsa de dinero. Con 0 cajas existentes es el
  // primero: estrena "Caja 1" sin preguntar (la elección se ignora en el server).
  const isFirstDevice = registerCajas.length === 0;
  const [shareMode, setShareMode] = useState(false);
  const [shareCajaId, setShareCajaId] = useState(
    registerCajas[0]?.id ?? '',
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const cajaChoice = isFirstDevice
        ? undefined
        : shareMode && shareCajaId
          ? ({ mode: 'shared', shareWithCajaId: shareCajaId } as const)
          : ({ mode: 'exclusive' } as const);
      const result = await createPosToken({
        deviceName,
        adminPin: adminPin.trim(),
        cajaChoice,
      });
      if (!result.ok) {
        onFailure(result);
        return;
      }
      onSuccess(result.data);
    } catch {
      onFailure({ ok: false, error: 'No se pudo crear la caja' });
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
            <label htmlFor="pt-admin-pin" className={labelCls}>
              PIN del administrador
            </label>
            <input
              id="pt-admin-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              required
              pattern="[0-9]*"
              minLength={4}
              maxLength={6}
              placeholder="Ej. 1234 (mínimo 4 dígitos)"
              value={adminPin}
              onChange={e => setAdminPin(e.target.value.replace(/\D/g, ''))}
              className={inputCls}
            />
          </div>

          {isFirstDevice
            ? (
                <p className="
                  flex items-center gap-2 rounded-md border border-input
                  bg-muted/30 px-3 py-2 text-xs text-muted-foreground
                "
                >
                  <Wallet className="size-4 shrink-0" />
                  Se creará
                  {' '}
                  <span className="font-medium text-foreground">Caja 1</span>
                  {' '}
                  como su bolsa de dinero.
                </p>
              )
            : (
                <div className="space-y-2 rounded-md border border-input p-3">
                  <div className="text-xs font-medium text-muted-foreground">
                    Bolsa de dinero (dónde se guarda el efectivo)
                  </div>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="caja-choice"
                      checked={!shareMode}
                      onChange={() => setShareMode(false)}
                      className="mt-0.5"
                    />
                    <span>
                      Caja exclusiva para este dispositivo
                      <span className="block text-xs text-muted-foreground">
                        Se crea una bolsa nueva («Caja N») solo para este POS.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="caja-choice"
                      checked={shareMode}
                      onChange={() => setShareMode(true)}
                      className="mt-0.5"
                    />
                    <span>
                      Compartir el lugar del dinero con otro POS
                      <span className="block text-xs text-muted-foreground">
                        Ambos dispositivos usan la misma bolsa (caja compartida).
                      </span>
                    </span>
                  </label>
                  {shareMode && (
                    <select
                      value={shareCajaId}
                      onChange={e => setShareCajaId(e.target.value)}
                      className={`
                        ${inputCls}
                        cursor-pointer
                      `}
                    >
                      {registerCajas.map(c => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

          <p className="
            rounded-md border border-input bg-muted/30 px-3 py-2 text-xs
            text-muted-foreground
          "
          >
            La caja queda asignada a vos (administrador) como responsable por
            defecto y aparecés en el selector del dispositivo. Cuando tengas
            empleados, podés entregarles la caja desde el menú de cada caja.
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
            <Button
              type="submit"
              disabled={submitting || !deviceName.trim() || adminPin.length < 4}
            >
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
            Escanea el QR con la cámara del dispositivo de la caja: abre
            {' '}
            <span className="font-medium text-foreground">{TIENDA_CAJERO_URL.replace('https://', '')}</span>
            {' '}
            con el código ya cargado.
          </li>
          <li>
            También puedes abrir el POS y usar su botón «Escanear QR», o pegar
            el código de acceso a mano.
          </li>
          <li>La caja queda vinculada y empieza a sincronizar.</li>
        </ol>

        <div className="flex flex-col items-center gap-4">
          {/* eslint-disable-next-line next/no-img-element */}
          <img
            src={qrUrl(accessLink(token.token))}
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

function RenameModal({
  token,
  onClose,
  onSaved,
  onError,
}: {
  token: TokenRow;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(token.deviceName);
  const [submitting, setSubmitting] = useState(false);

  const trimmed = name.trim();
  const nameValid = trimmed.length > 0;
  const unchanged = trimmed === token.deviceName.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameValid || unchanged) {
      return;
    }
    setSubmitting(true);
    try {
      const result = await renamePosToken(token.id, trimmed);
      if (!result.ok) {
        onError(result.error);
        return;
      }
      onSaved();
    } catch {
      onError('No se pudo cambiar el nombre');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Pencil className="size-5" />
            Cambiar nombre
          </h2>
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

        <p className="mb-3 text-sm text-muted-foreground">
          Cambia la etiqueta visible de esta caja. El dispositivo sigue
          conectado: no hace falta volver a escanear el código.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="rename-input" className={labelCls}>
              Nombre de la caja / dispositivo
              {' '}
              <span className="text-destructive">*</span>
            </label>
            <input
              id="rename-input"
              type="text"
              required
              autoFocus
              placeholder="Caja 1 - tablet mostrador"
              value={name}
              onChange={e => setName(e.target.value)}
              className={inputCls}
            />
            {!nameValid && (
              <p className="mt-1 text-xs text-destructive">
                El nombre no puede quedar vacío.
              </p>
            )}
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
            <Button
              type="submit"
              disabled={submitting || !nameValid || unchanged}
            >
              {submitting ? 'Guardando…' : 'Guardar nombre'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SweepDestinationModal({
  token,
  cofres,
  onClose,
  onSaved,
  onError,
}: {
  token: TokenRow;
  cofres: CofreOption[];
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    token.defaultSweepDestinationAccountId ?? null,
  );
  const [submitting, setSubmitting] = useState(false);

  const handleSave = async () => {
    setSubmitting(true);
    try {
      const result = await setPosTokenSweepDestination(token.id, selectedId);
      if (!result.ok) {
        onError(result.error);
        return;
      }
      onSaved();
    } catch {
      onError('No se pudo guardar el destino de barrido');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Vault className="size-5" />
            Destino de barrido
          </h2>
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

        <p className="mb-3 text-sm text-muted-foreground">
          Cuando esta caja abre con menos efectivo del que cerró, la diferencia
          se registra automáticamente. Elegí a qué cofre va ese monto.
          Si no elegís ninguno, queda en "Pendiente de ubicar".
        </p>

        <div className="space-y-2">
          <label htmlFor={`sweep-dest-${token.id}`} className={labelCls}>
            Cofre destino
          </label>
          <select
            id={`sweep-dest-${token.id}`}
            value={selectedId ?? ''}
            onChange={e => setSelectedId(e.target.value || null)}
            className={`
              ${inputCls}
              cursor-pointer
            `}
          >
            <option value="">Sin destino fijo (Pendiente de ubicar)</option>
            {cofres.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancelar
          </Button>
          <Button type="button" onClick={handleSave} disabled={submitting}>
            {submitting ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Cambiar la bolsa de dinero (caja) de un dispositivo, reemplaza al viejo
// CajasManager: compartir la bolsa de otro POS (assignDeviceToCaja) o sacarlo a
// su propia caja (splitDeviceToOwnCaja). Al vaciar una caja, el server la archiva.
function CajaManageModal({
  token,
  caja,
  otherCajas,
  pending,
  onClose,
  onShare,
  onSplit,
}: {
  token: TokenRow;
  caja: CajaConfig | null;
  otherCajas: CajaConfig[];
  pending: boolean;
  onClose: () => void;
  onShare: (cajaId: string) => void;
  onSplit: () => void;
}) {
  const [shareCajaId, setShareCajaId] = useState(otherCajas[0]?.id ?? '');

  return (
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Wallet className="size-5" />
            Bolsa de dinero
          </h2>
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

        <p className="mb-3 text-sm text-muted-foreground">
          {token.deviceName}
          {' '}
          usa la bolsa
          {' '}
          <span className="font-medium text-foreground">
            {caja?.name ?? '—'}
          </span>
          {caja?.isShared && (
            <>
              {' '}
              (compartida con
              {' '}
              {caja.devices.length - 1}
              {' '}
              POS más)
            </>
          )}
          .
        </p>

        <div className="space-y-4">
          {caja?.isShared && (
            <div className="rounded-md border p-3">
              <div className="text-sm font-medium">Sacar a caja propia</div>
              <p className="mb-2 text-xs text-muted-foreground">
                Este POS deja de compartir y estrena su propia bolsa («Caja N»).
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={onSplit}
              >
                <Split className="size-4" />
                Separar a caja propia
              </Button>
            </div>
          )}

          {otherCajas.length > 0 && (
            <div className="rounded-md border p-3">
              <div className="text-sm font-medium">Compartir con otro POS</div>
              <p className="mb-2 text-xs text-muted-foreground">
                Este POS pasa a usar la misma bolsa de la caja elegida. Si su
                caja actual queda vacía, se archiva con su fecha.
              </p>
              <div className="flex items-center gap-2">
                <select
                  value={shareCajaId}
                  onChange={e => setShareCajaId(e.target.value)}
                  className={`
                    ${inputCls}
                    cursor-pointer
                  `}
                >
                  {otherCajas.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  disabled={pending || !shareCajaId}
                  onClick={() => onShare(shareCajaId)}
                >
                  <Users className="size-4" />
                  Compartir
                </Button>
              </div>
            </div>
          )}

          {!caja?.isShared && otherCajas.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No hay otras cajas con las que compartir todavía.
            </p>
          )}
        </div>

        <div className="flex justify-end pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </div>
  );
}
