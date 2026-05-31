'use client';

import type {
  listOrgCashiers,
} from '@/actions/pos-tokens';
import { ExternalLink } from 'lucide-react';
import { useCallback, useState, useTransition } from 'react';
import {
  createPosToken,
  listPosTokens,
  revokePosToken,
} from '@/actions/pos-tokens';
import { Button } from '@/components/ui/button';

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

export function PosCajerosClient({
  initialTokens,
  initialCashiers,
}: {
  initialTokens: TokenRow[];
  initialCashiers: CashierRow[];
}) {
  const [tokens, setTokens] = useState(initialTokens);
  const [cashiers] = useState(initialCashiers);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [activeToken, setActiveToken] = useState<TokenRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const refresh = useCallback(() => {
    startTransition(async () => {
      const rows = await listPosTokens();
      setTokens(rows);
    });
  }, []);

  const handleRevoke = (id: string) => {
    // eslint-disable-next-line no-alert
    if (!globalThis.confirm('Revocar este token? El dispositivo dejará de sincronizar.')) {
      return;
    }
    startTransition(async () => {
      try {
        await revokePosToken(id);
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to revoke');
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
            Dismiss
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="text-lg font-semibold">POS Cajeros</div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <a
              href={TIENDA_CAJERO_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-4" />
              Abrir TiendaCajero
            </a>
          </Button>
          <Button onClick={() => setShowCreateModal(true)} disabled={pending}>
            Generar nuevo token
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Dispositivo</th>
              <th className="px-3 py-2">Cajero</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Último sync</th>
              <th className="px-3 py-2">Expira</th>
              <th className="px-3 py-2">Creado</th>
              <th className="px-3 py-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {tokens.length === 0 && (
              <tr>
                <td
                  className="px-3 py-6 text-center text-muted-foreground"
                  colSpan={7}
                >
                  Aún no hay tokens. Genera uno para registrar un dispositivo.
                </td>
              </tr>
            )}
            {tokens.map(t => (
              <tr key={t.id} className="border-t">
                <td className="px-3 py-2">{t.deviceName}</td>
                <td className="px-3 py-2">{t.cashierName ?? '—'}</td>
                <td className="px-3 py-2">
                  {t.active
                    ? (
                        <span className="text-emerald-700">activo</span>
                      )
                    : (
                        <span className="text-muted-foreground">revocado</span>
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
                    Ver QR
                  </Button>
                  {t.active && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleRevoke(t.id)}
                      disabled={pending}
                    >
                      Revocar
                    </Button>
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
          onError={err =>
            setError(err instanceof Error ? err.message : String(err))}
        />
      )}

      {activeToken && (
        <QrModal token={activeToken} onClose={() => setActiveToken(null)} />
      )}
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
          <h2 className="text-lg font-semibold">Nuevo token POS</h2>
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
              Nombre del dispositivo
            </label>
            <input
              id="pt-device"
              type="text"
              required
              placeholder="Caja 1 - iPad mostrador"
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
              {submitting ? 'Generando…' : 'Generar token'}
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

        <div className="flex flex-col items-center gap-4">
          {/* eslint-disable-next-line next/no-img-element */}
          <img
            src={qrUrl(token.token)}
            alt={`QR de ${token.deviceName}`}
            width={220}
            height={220}
            className="rounded-md border bg-white p-2"
          />

          <div className="w-full">
            <div className={labelCls}>Token</div>
            <div className="
              mt-1 rounded-md border bg-muted/40 p-2 font-mono text-xs break-all
            "
            >
              {token.token}
            </div>
          </div>

          <div className="flex w-full justify-end gap-2">
            <Button variant="secondary" onClick={handleCopy}>
              {copied ? 'Copiado ✓' : 'Copiar token'}
            </Button>
            <Button onClick={onClose}>Cerrar</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
