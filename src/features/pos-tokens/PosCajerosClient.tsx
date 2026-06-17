'use client';

import type { OrgAddress } from '@/actions/org-addresses';
import type { PosDeviceQuota } from '@/actions/pos-tokens';
import type { ActionResult } from '@/libs/action-result';
import {
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ExternalLink,
  Lock,
  MapPin,
  Monitor,
  MoreVertical,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  Trash2,
  Unlock,
  Vault,
} from 'lucide-react';
import { useCallback, useState, useTransition } from 'react';
import {
  blockPosToken,
  createPosToken,
  deletePosToken,
  forceLogoutPosToken,
  getPosDeviceQuota,
  listPosTokens,
  regeneratePosToken,
  renamePosToken,
  setPosTokenAddress,
  setPosTokenSweepDestination,
  unblockPosToken,
} from '@/actions/pos-tokens';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link } from '@/libs/I18nNavigation';
import { POS_DEVICES_LIMIT_REACHED } from '@/libs/plan-limits';
import { AddressPicker } from './AddressPicker';

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
  initialAddresses,
  initialCofres,
}: {
  initialTokens: TokenRow[];
  initialQuota: PosDeviceQuota;
  initialAddresses: OrgAddress[];
  initialCofres: CofreOption[];
}) {
  const confirm = useConfirm();
  const [tokens, setTokens] = useState(initialTokens);
  const [quota, setQuota] = useState(initialQuota);
  const [addresses, setAddresses] = useState(initialAddresses);
  const [cofres] = useState(initialCofres);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [activeToken, setActiveToken] = useState<TokenRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TokenRow | null>(null);
  const [renameTarget, setRenameTarget] = useState<TokenRow | null>(null);
  const [addressTarget, setAddressTarget] = useState<TokenRow | null>(null);
  const [sweepTarget, setSweepTarget] = useState<TokenRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<LimitErrorPayload | null>(null);
  const [pending, startTransition] = useTransition();

  const atLimit = quota.used >= quota.limit;

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

  const handleConfirmDelete = () => {
    if (!deleteTarget) {
      return;
    }
    const id = deleteTarget.id;
    startTransition(async () => {
      try {
        const result = await deletePosToken(id);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setDeleteTarget(null);
        refresh();
      } catch {
        setError('No se pudo eliminar');
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
                  colSpan={5}
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
                  {t.address && (
                    <div className="
                      mt-1 flex items-center gap-1 text-xs text-muted-foreground
                    "
                    >
                      <MapPin className="size-3" />
                      {[t.addressName, t.address, t.addressCity]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
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
                        <DropdownMenuItem onClick={() => setAddressTarget(t)}>
                          <MapPin className="size-4" />
                          Dirección / sucursal
                        </DropdownMenuItem>
                        {cofres.length > 0 && (
                          <DropdownMenuItem onClick={() => setSweepTarget(t)}>
                            <Vault className="size-4" />
                            Destino de barrido
                          </DropdownMenuItem>
                        )}
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
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleteTarget(t)}
                        >
                          <Trash2 className="size-4" />
                          Eliminar caja
                        </DropdownMenuItem>
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
          addresses={addresses}
          onAddressesChange={setAddresses}
          onClose={() => setShowCreateModal(false)}
          onSuccess={(created) => {
            setShowCreateModal(false);
            setActiveToken({
              id: created.id,
              token: created.token,
              storeId: created.storeId,
              deviceName: created.deviceName,
              createdBy: created.createdBy,
              currentCashierId: created.currentCashierId,
              currentCashierName: null,
              currentCashierAt: created.currentCashierAt,
              addressId: created.addressId,
              addressName: addresses.find(a => a.id === created.addressId)?.name ?? null,
              address: addresses.find(a => a.id === created.addressId)?.address ?? null,
              addressCity: addresses.find(a => a.id === created.addressId)?.city ?? null,
              active: created.active,
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

      {addressTarget && (
        <AddressModal
          token={addressTarget}
          addresses={addresses}
          onAddressesChange={setAddresses}
          onClose={() => setAddressTarget(null)}
          onSaved={() => {
            setAddressTarget(null);
            refresh();
          }}
          onError={msg => setError(msg)}
        />
      )}

      {deleteTarget && (
        <DeleteCajaModal
          token={deleteTarget}
          pending={pending}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleConfirmDelete}
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
  addresses,
  onAddressesChange,
  onClose,
  onSuccess,
  onFailure,
}: {
  addresses: OrgAddress[];
  onAddressesChange: (next: OrgAddress[]) => void;
  onClose: () => void;
  onSuccess: (token: CreatedToken) => void;
  onFailure: (failure: ActionFailure) => void;
}) {
  const [deviceName, setDeviceName] = useState('');
  const [addressId, setAddressId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await createPosToken({
        deviceName,
        addressId,
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
            <span className={labelCls}>Dirección / sucursal (opcional)</span>
            <div className="mt-1">
              <AddressPicker
                addresses={addresses}
                selectedId={addressId}
                onSelect={setAddressId}
                onAddressesChange={onAddressesChange}
              />
            </div>
          </div>
          <p className="
            rounded-md border border-input bg-muted/30 px-3 py-2 text-xs
            text-muted-foreground
          "
          >
            La caja abre solo con el código de acceso (escrito o escaneado). Cada
            empleado responde por lo que hace con su PIN personal, que configura
            en su perfil.
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
              {submitting ? 'Creando…' : 'Crear caja'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AddressModal({
  token,
  addresses,
  onAddressesChange,
  onClose,
  onSaved,
  onError,
}: {
  token: TokenRow;
  addresses: OrgAddress[];
  onAddressesChange: (next: OrgAddress[]) => void;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(token.addressId);
  const [submitting, setSubmitting] = useState(false);

  const handleSave = async () => {
    setSubmitting(true);
    try {
      const result = await setPosTokenAddress(token.id, selectedId);
      if (!result.ok) {
        onError(result.error);
        return;
      }
      onSaved();
    } catch {
      onError('No se pudo asignar la dirección');
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
            <MapPin className="size-5" />
            Dirección de
            {' '}
            {token.deviceName}
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
          La sucursal de esta caja. Es la dirección que sale en el ticket. Podés
          elegir una existente, crear una nueva o editar la seleccionada.
        </p>

        <AddressPicker
          addresses={addresses}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAddressesChange={onAddressesChange}
          allowEdit
        />

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
            {submitting ? 'Guardando…' : 'Asignar a la caja'}
          </Button>
        </div>
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

function DeleteCajaModal({
  token,
  pending,
  onCancel,
  onConfirm,
}: {
  token: TokenRow;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="
            flex items-center gap-2 text-lg font-semibold text-destructive
          "
          >
            <Trash2 className="size-5" />
            Eliminar caja
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="
              text-muted-foreground
              hover:text-foreground
            "
          >
            ✕
          </button>
        </div>

        <p className="text-sm text-foreground">
          Vas a eliminar
          {' '}
          <span className="font-semibold">{token.deviceName}</span>
          .
        </p>
        <ul className="
          mt-3 list-disc space-y-1 rounded-md bg-destructive/10 py-3 pr-3 pl-8
          text-xs text-destructive
        "
        >
          <li>El dispositivo perderá el acceso de inmediato.</li>
          <li>Se libera un cupo de caja de tu plan.</li>
          <li>Esta acción es permanente y no se puede deshacer.</li>
        </ul>

        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={e => setConfirmed(e.target.checked)}
            className="mt-0.5"
          />
          <span>Entiendo que esta acción es permanente.</span>
        </label>

        <div className="
          mt-6 flex flex-col-reverse gap-2
          sm:flex-row
        "
        >
          <Button
            type="button"
            variant="outline"
            className="sm:flex-1"
            onClick={onCancel}
            disabled={pending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="sm:flex-1"
            onClick={onConfirm}
            disabled={pending || !confirmed}
          >
            {pending
              ? 'Eliminando…'
              : (
                  <>
                    <Trash2 className="size-4" />
                    Sí, eliminar caja
                  </>
                )}
          </Button>
        </div>
      </div>
    </div>
  );
}
