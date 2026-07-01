'use client';

import type { WhatsAppChannelRow } from '@/actions/whatsapp-channels';
import { useEffect, useRef, useState } from 'react';
import {
  createWhatsAppChannel,
  deleteWhatsAppChannel,
  getWhatsAppChannelStatus,
  refreshWhatsAppChannelQr,
  updateWhatsAppChannel,
} from '@/actions/whatsapp-channels';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';

// What the agent may do on a channel. The admin picks per channel; the agent
// (n8n) enforces it. Persisted in whatsapp_channels.capabilities.
const CAPABILITIES: { key: string; label: string; sub: string }[] = [
  { key: 'products_lookup', label: 'Consultar productos', sub: 'Precios y disponibilidad' },
  { key: 'sales_query', label: 'Consultar ventas', sub: 'Lectura de reportes' },
  { key: 'orders', label: 'Tomar pedidos', sub: 'Crea ventas en POS' },
  { key: 'creditos', label: 'Gestionar creditos', sub: 'Registrar y consultar' },
  { key: 'inventory_query', label: 'Consultar inventario', sub: 'Stock y alertas' },
  { key: 'cash_query', label: 'Consultar caja', sub: 'Solo lectura' },
  { key: 'price_changes', label: 'Cambiar precios', sub: 'Confirmación en chat' },
  { key: 'alerts', label: 'Enviar alertas', sub: 'Stock bajo, creditos, caja' },
];

// The friendly one-switch preset. Turning "Agente de Domicilios" ON enables
// exactly the capability bundle the delivery agent needs: product lookup +
// order taking (the `orders` flag also governs /deliveries and /deliveries/quote;
// customer lookup needs no flag). Advanced users still tune the granular flags
// above under the "Avanzado" disclosure.
const DELIVERY_PRESET_KEYS = ['products_lookup', 'orders'] as const;

function isDeliveryPresetOn(caps: Record<string, boolean>): boolean {
  return DELIVERY_PRESET_KEYS.every(key => caps[key] === true);
}

const STATUS_LABEL: Record<WhatsAppChannelRow['status'], string> = {
  connecting: 'Conectando…',
  connected: 'Conectado',
  disconnected: 'Desconectado',
};

const STATUS_CLASS: Record<WhatsAppChannelRow['status'], string> = {
  connecting: 'bg-amber-500/10 text-amber-600',
  connected: 'bg-emerald-500/10 text-emerald-600',
  disconnected: 'bg-destructive/10 text-destructive',
};

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

function qrSrc(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`;
}

function countCapabilities(caps: Record<string, boolean>): number {
  return Object.values(caps).filter(Boolean).length;
}

// Real WhatsApp connection panel: lists persisted channels, connects a new
// number via QR (Evolution instance) with a purpose + agent permissions, edits
// them, and removes channels.
export function WhatsAppChannelsPanel({
  initialChannels,
  configured,
}: {
  initialChannels: WhatsAppChannelRow[];
  configured: boolean;
}) {
  const confirm = useConfirm();
  const [channels, setChannels] = useState(initialChannels);
  const [error, setError] = useState<string | null>(null);
  // `editing` drives the form dialog: 'new' to create, a row to edit, null closed.
  const [editing, setEditing] = useState<WhatsAppChannelRow | 'new' | null>(null);
  const [active, setActive] = useState<{ channel: WhatsAppChannelRow; qr: string | null } | null>(
    null,
  );

  const handleCreated = (channel: WhatsAppChannelRow, qrBase64: string | null) => {
    setChannels(prev => [channel, ...prev]);
    setEditing(null);
    setActive({ channel, qr: qrBase64 });
  };

  const handleUpdated = (channel: WhatsAppChannelRow) => {
    setChannels(prev => prev.map(c => (c.id === channel.id ? channel : c)));
    setEditing(null);
  };

  const handleConnected = (id: string, phoneNumber: string | null) => {
    setChannels(prev =>
      prev.map(c =>
        c.id === id ? { ...c, status: 'connected', phoneNumber } : c,
      ),
    );
    setActive(null);
  };

  const handleDelete = async (row: WhatsAppChannelRow) => {
    const ok = await confirm({
      title: `¿Eliminar el canal${row.phoneNumber ? ` ${row.phoneNumber}` : ''}?`,
      description:
        'Se cerrará la sesión de WhatsApp y se borrará la instancia. El número quedará libre para reconectar después.',
      confirmText: 'Eliminar',
      tone: 'destructive',
    });
    if (!ok) {
      return;
    }
    const prev = channels;
    setChannels(p => p.filter(c => c.id !== row.id));
    try {
      await deleteWhatsAppChannel(row.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo eliminar');
      setChannels(prev);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Conexión de WhatsApp</h2>
          <p className="text-sm text-muted-foreground">
            Conectá un número por QR, dale un propósito y elegí qué puede hacer la
            IA en ese canal. Cada número es su propia instancia.
          </p>
        </div>
        <Button onClick={() => setEditing('new')} disabled={!configured}>
          Conectar WhatsApp
        </Button>
      </div>

      {!configured && (
        <div className="
          rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3
          text-sm text-amber-700
        "
        >
          WhatsApp no está configurado. Falta definir
          {' '}
          <code className="font-mono">EVOLUTION_API_URL</code>
          {' '}
          y
          {' '}
          <code className="font-mono">EVOLUTION_API_KEY</code>
          {' '}
          en el entorno.
        </div>
      )}

      {error && (
        <div className="
          rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2
          text-sm text-destructive
        "
        >
          {error}
          <button type="button" className="ml-3 underline" onClick={() => setError(null)}>
            Cerrar
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-md border bg-background">
        <div className="
          grid grid-cols-[1fr_120px_120px_120px] gap-2 border-b bg-muted/50 px-3
          py-2 text-xs font-medium text-muted-foreground uppercase
        "
        >
          <div>Canal</div>
          <div>Permisos</div>
          <div>Estado</div>
          <div className="text-right">Acciones</div>
        </div>

        {channels.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            Sin canales. Conectá tu primer número con «Conectar WhatsApp».
          </div>
        )}

        {channels.map(row => (
          <div
            key={row.id}
            className="
              grid grid-cols-[1fr_120px_120px_120px] items-center gap-2 border-b
              px-3 py-2 text-sm
              last:border-b-0
            "
          >
            <div className="min-w-0">
              <div className="font-medium">
                {row.phoneNumber ?? row.label ?? 'Canal nuevo'}
              </div>
              {(row.purpose || row.label) && (
                <div className="truncate text-xs text-muted-foreground">
                  {row.purpose || row.label}
                </div>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {countCapabilities(row.capabilities)}
              {' '}
              activos
            </div>
            <div>
              <span className={`
                rounded-full px-2.5 py-1 text-xs font-semibold
                ${STATUS_CLASS[row.status]}
              `}
              >
                {STATUS_LABEL[row.status]}
              </span>
            </div>
            <div className="flex justify-end gap-2">
              {row.status !== 'connected' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setActive({ channel: row, qr: null })}
                >
                  Ver QR
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => setEditing(row)}>
                Editar
              </Button>
              <Button size="sm" variant="destructive" onClick={() => handleDelete(row)}>
                Eliminar
              </Button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <ChannelFormDialog
          channel={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={handleCreated}
          onUpdated={handleUpdated}
          onError={msg => setError(msg)}
        />
      )}

      {active && (
        <QrModal
          channel={active.channel}
          initialQr={active.qr}
          onClose={() => setActive(null)}
          onConnected={handleConnected}
        />
      )}
    </div>
  );
}

function ChannelFormDialog({
  channel,
  onClose,
  onCreated,
  onUpdated,
  onError,
}: {
  channel: WhatsAppChannelRow | null;
  onClose: () => void;
  onCreated: (channel: WhatsAppChannelRow, qrBase64: string | null) => void;
  onUpdated: (channel: WhatsAppChannelRow) => void;
  onError: (msg: string) => void;
}) {
  const isEdit = channel !== null;
  const [label, setLabel] = useState(channel?.label ?? '');
  const [purpose, setPurpose] = useState(channel?.purpose ?? '');
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>(
    channel?.capabilities ?? {},
  );
  const [submitting, setSubmitting] = useState(false);
  // Open the advanced disclosure if the channel already has a non-preset flag on,
  // so editing never hides a permission the owner had enabled.
  const [showAdvanced, setShowAdvanced] = useState(() =>
    Object.entries(channel?.capabilities ?? {}).some(
      ([key, on]) =>
        on === true && !(DELIVERY_PRESET_KEYS as readonly string[]).includes(key),
    ),
  );

  const toggle = (key: string, next: boolean) =>
    setCapabilities(prev => ({ ...prev, [key]: next }));

  const deliveryPresetOn = isDeliveryPresetOn(capabilities);
  const toggleDeliveryPreset = (next: boolean) =>
    setCapabilities(prev => ({
      ...prev,
      products_lookup: next,
      orders: next,
    }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const input = { label, purpose, capabilities };
      if (isEdit) {
        onUpdated(await updateWhatsAppChannel(channel.id, input));
      } else {
        const { channel: created, qrBase64 } = await createWhatsAppChannel(input);
        onCreated(created, qrBase64);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'No se pudo guardar el canal');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={next => !next && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Editar canal' : 'Nuevo canal de WhatsApp'}</DialogTitle>
          <DialogDescription>
            Definí para qué sirve este canal y qué puede hacer la IA en él.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="wa-label"
              className="text-xs font-medium text-muted-foreground"
            >
              Etiqueta
            </label>
            <input
              id="wa-label"
              type="text"
              value={label}
              placeholder="WhatsApp principal"
              onChange={e => setLabel(e.target.value)}
              className={inputCls}
            />
          </div>

          <div>
            <label
              htmlFor="wa-purpose"
              className="text-xs font-medium text-muted-foreground"
            >
              Propósito
            </label>
            <input
              id="wa-purpose"
              type="text"
              value={purpose}
              placeholder="Atención clientes / Confirmación de pedidos / Alertas"
              onChange={e => setPurpose(e.target.value)}
              className={inputCls}
            />
          </div>

          <div className="space-y-3">
            <p className="
              text-xs font-semibold tracking-wider text-muted-foreground
              uppercase
            "
            >
              Permisos del bot en este canal
            </p>

            {/* Preset primario y amigable: una sola llave para el caso de uso real. */}
            <label
              htmlFor="wa-preset-delivery"
              className={`
                flex cursor-pointer items-start gap-3 rounded-lg border p-3
                ${deliveryPresetOn
      ? 'border-brand/50 bg-brand-soft/40'
      : 'bg-background'}
              `}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Activar Agente de Domicilios</p>
                <p className="text-xs text-muted-foreground">
                  Enciende de una lo que el agente necesita para atender pedidos:
                  consultar productos y tomar pedidos/domicilios. Los clientes se
                  buscan solos.
                </p>
              </div>
              <Switch
                id="wa-preset-delivery"
                checked={deliveryPresetOn}
                aria-label="Activar Agente de Domicilios"
                onCheckedChange={toggleDeliveryPreset}
              />
            </label>

            {/* Los toggles granulares siguen siendo el límite de seguridad que cada
                endpoint valida; quedan bajo "Avanzado" para no abrumar. */}
            <div className="rounded-md border bg-background">
              <button
                type="button"
                onClick={() => setShowAdvanced(s => !s)}
                aria-expanded={showAdvanced}
                className="
                  flex w-full items-center justify-between px-3 py-2 text-xs
                  font-semibold text-muted-foreground
                "
              >
                <span>Avanzado · permisos individuales</span>
                <span aria-hidden className="text-base leading-none">
                  {showAdvanced ? '−' : '+'}
                </span>
              </button>

              {showAdvanced && (
                <div className="
                  grid gap-2 border-t p-2.5
                  sm:grid-cols-2
                "
                >
                  {CAPABILITIES.map((c) => {
                    const on = capabilities[c.key] === true;
                    return (
                      <label
                        key={c.key}
                        htmlFor={`wa-cap-${c.key}`}
                        className={`
                          flex cursor-pointer items-center gap-3 rounded-md
                          border p-2.5
                          ${on
                        ? 'border-brand/40 bg-brand-soft/40'
                        : `bg-background`}
                        `}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold">{c.label}</p>
                          <p className="text-[10px] text-muted-foreground">{c.sub}</p>
                        </div>
                        <Switch
                          id={`wa-cap-${c.key}`}
                          checked={on}
                          aria-label={c.label}
                          onCheckedChange={next => toggle(c.key, next)}
                        />
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? (isEdit ? 'Guardando…' : 'Creando…')
                : (isEdit ? 'Guardar' : 'Conectar')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function QrModal({
  channel,
  initialQr,
  onClose,
  onConnected,
}: {
  channel: WhatsAppChannelRow;
  initialQr: string | null;
  onClose: () => void;
  onConnected: (id: string, phoneNumber: string | null) => void;
}) {
  const [qr, setQr] = useState<string | null>(initialQr);
  const [status, setStatus] = useState<WhatsAppChannelRow['status']>(channel.status);
  const [refreshing, setRefreshing] = useState(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  // Pull a QR if we opened "Ver QR" on an existing channel without one.
  useEffect(() => {
    if (qr) {
      return;
    }
    let cancelled = false;
    refreshWhatsAppChannelQr(channel.id)
      .then(({ qrBase64 }) => {
        if (!cancelled && qrBase64) {
          setQr(qrBase64);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [channel.id, qr]);

  // Poll connection state until the number finishes scanning.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await getWhatsAppChannelStatus(channel.id);
        if (stop) {
          return;
        }
        setStatus(res.status);
        if (res.status === 'connected') {
          stop = true;
          onConnectedRef.current(channel.id, res.phoneNumber);
        }
      } catch {
        // transient — keep polling
      }
    };
    const interval = setInterval(tick, 3000);
    tick();
    return () => {
      stop = true;
      clearInterval(interval);
    };
  }, [channel.id]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const { qrBase64 } = await refreshWhatsAppChannelQr(channel.id);
      setQr(qrBase64);
    } catch {
      // ignore — user can retry
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="
        w-full max-w-sm rounded-lg bg-background p-6 text-center shadow-lg
      "
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Conectar WhatsApp</h2>
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

        {status === 'connected'
          ? (
              <div className="space-y-3 py-6">
                <div className="text-4xl">✅</div>
                <p className="text-sm font-medium">¡Número conectado!</p>
              </div>
            )
          : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Abrí WhatsApp en tu teléfono →
                  {' '}
                  <strong>Dispositivos vinculados</strong>
                  {' '}
                  → Vincular un dispositivo, y escaneá este código.
                </p>
                <div className="
                  mx-auto flex aspect-square w-56 items-center justify-center
                  rounded-md border bg-white
                "
                >
                  {qr
                    ? (
                        // eslint-disable-next-line next/no-img-element
                        <img
                          src={qrSrc(qr)}
                          alt="Código QR de WhatsApp"
                          className="size-full"
                        />
                      )
                    : (
                        <span className="text-sm text-muted-foreground">Generando QR…</span>
                      )}
                </div>
                <div className="
                  flex items-center justify-center gap-2 text-xs
                  text-muted-foreground
                "
                >
                  <span className="
                    inline-block size-2 animate-pulse rounded-full bg-amber-500
                  "
                  />
                  Esperando conexión…
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleRefresh}
                  disabled={refreshing}
                >
                  {refreshing ? 'Actualizando…' : 'Actualizar QR'}
                </Button>
              </div>
            )}
      </div>
    </div>
  );
}
