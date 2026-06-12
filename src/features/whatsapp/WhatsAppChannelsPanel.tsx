'use client';

import type { WhatsAppChannelRow } from '@/actions/whatsapp-channels';
import { useEffect, useRef, useState } from 'react';
import {
  createWhatsAppChannel,
  deleteWhatsAppChannel,
  getWhatsAppChannelStatus,
  refreshWhatsAppChannelQr,
} from '@/actions/whatsapp-channels';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';

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

function qrSrc(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`;
}

// Real WhatsApp connection panel: lists persisted channels, connects a new
// number via QR (Evolution instance), and removes channels. Shared between the
// AI agent "Canales" section and anywhere else WhatsApp connection is offered.
export function WhatsAppChannelsPanel({
  initialChannels,
  configured,
  webhookConfigured,
}: {
  initialChannels: WhatsAppChannelRow[];
  configured: boolean;
  webhookConfigured: boolean;
}) {
  const confirm = useConfirm();
  const [channels, setChannels] = useState(initialChannels);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState<{ channel: WhatsAppChannelRow; qr: string | null } | null>(
    null,
  );

  const handleConnect = async () => {
    setError(null);
    setCreating(true);
    try {
      const { channel, qrBase64 } = await createWhatsAppChannel();
      setChannels(prev => [channel, ...prev]);
      setActive({ channel, qr: qrBase64 });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear el canal');
    } finally {
      setCreating(false);
    }
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
            Conectá un número escaneando un QR. Cada número levanta su propia
            instancia y los mensajes entrantes se procesan automáticamente.
          </p>
        </div>
        <Button onClick={handleConnect} disabled={!configured || creating}>
          {creating ? 'Creando…' : 'Conectar WhatsApp'}
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

      {configured && !webhookConfigured && (
        <div className="
          rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3
          text-sm text-amber-700
        "
        >
          Los canales se conectan, pero los mensajes entrantes no se reenviarán
          hasta definir
          {' '}
          <code className="font-mono">WHATSAPP_N8N_WEBHOOK_URL</code>
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
          grid grid-cols-[1fr_140px_120px] gap-2 border-b bg-muted/50 px-3 py-2
          text-xs font-medium text-muted-foreground uppercase
        "
        >
          <div>Canal</div>
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
              grid grid-cols-[1fr_140px_120px] items-center gap-2 border-b px-3
              py-2 text-sm
              last:border-b-0
            "
          >
            <div className="min-w-0">
              <div className="font-medium">
                {row.phoneNumber ?? row.label ?? 'Canal nuevo'}
              </div>
              {row.phoneNumber && row.label && (
                <div className="truncate text-xs text-muted-foreground">{row.label}</div>
              )}
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
              <Button size="sm" variant="destructive" onClick={() => handleDelete(row)}>
                Eliminar
              </Button>
            </div>
          </div>
        ))}
      </div>

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
