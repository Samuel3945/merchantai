'use client';

import type {
  BroadcastSeverity,
  BroadcastTarget,
  SentBroadcast,
} from '@/actions/platform-broadcast';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { sendBroadcast } from '@/actions/platform-broadcast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast-store';

const inputClass
  = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

type TargetKind = 'all' | 'status' | 'tag';

const SEVERITY_OPTIONS: { value: BroadcastSeverity; label: string }[] = [
  { value: 'low', label: 'Informativa' },
  { value: 'mid', label: 'Importante' },
  { value: 'high', label: 'Crítica' },
];

const STATUS_OPTIONS = [
  { value: 'trial', label: 'Prueba' },
  { value: 'vip', label: 'VIP' },
  { value: 'at_risk', label: 'En riesgo' },
  { value: 'churned', label: 'Perdido' },
];

export function BroadcastClient(props: { recent: SentBroadcast[] }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();

  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<BroadcastSeverity>('mid');
  const [targetKind, setTargetKind] = useState<TargetKind>('all');
  const [targetStatus, setTargetStatus] = useState('trial');
  const [targetTag, setTargetTag] = useState('');

  const send = async () => {
    const target: BroadcastTarget
      = targetKind === 'all'
        ? { kind: 'all' }
        : targetKind === 'status'
          ? { kind: 'status', status: targetStatus }
          : { kind: 'tag', tag: targetTag };

    const targetLabel
      = targetKind === 'all'
        ? 'TODOS los negocios'
        : targetKind === 'status'
          ? `los negocios con estado "${targetStatus}"`
          : `los negocios con tag "${targetTag}"`;

    const ok = await confirm({
      title: `¿Enviar la alerta a ${targetLabel}?`,
      description: title,
      confirmText: 'Enviar',
    });
    if (!ok) {
      return;
    }

    startTransition(async () => {
      const result = await sendBroadcast({ title, message, severity, target });
      if (result.ok) {
        toast.success(`Alerta enviada a ${result.data.delivered} negocios`);
        setTitle('');
        setMessage('');
        router.refresh();
      } else {
        toast.error(result.error ?? 'Error inesperado');
      }
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Alertas</h1>
        <p className="text-sm text-muted-foreground">
          Enviá un anuncio a la campana de notificaciones de los negocios.
        </p>
      </div>

      <div className="space-y-3 rounded-xl border bg-card p-4">
        <div>
          <label htmlFor="bc-title" className="text-xs font-medium">
            Título
          </label>
          <input
            id="bc-title"
            type="text"
            className={inputClass}
            value={title}
            placeholder="ej: Mantenimiento programado"
            onChange={e => setTitle(e.target.value)}
            disabled={pending}
          />
        </div>
        <div>
          <label htmlFor="bc-message" className="text-xs font-medium">
            Mensaje
          </label>
          <textarea
            id="bc-message"
            rows={3}
            className={inputClass}
            value={message}
            onChange={e => setMessage(e.target.value)}
            disabled={pending}
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="bc-severity" className="text-xs font-medium">
              Severidad
            </label>
            <select
              id="bc-severity"
              className={inputClass}
              value={severity}
              onChange={e => setSeverity(e.target.value as BroadcastSeverity)}
              disabled={pending}
            >
              {SEVERITY_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="bc-target" className="text-xs font-medium">
              Destino
            </label>
            <select
              id="bc-target"
              className={inputClass}
              value={targetKind}
              onChange={e => setTargetKind(e.target.value as TargetKind)}
              disabled={pending}
            >
              <option value="all">Todos los negocios</option>
              <option value="status">Por estado</option>
              <option value="tag">Por tag</option>
            </select>
          </div>
          {targetKind === 'status' && (
            <div>
              <label htmlFor="bc-status" className="text-xs font-medium">
                Estado
              </label>
              <select
                id="bc-status"
                className={inputClass}
                value={targetStatus}
                onChange={e => setTargetStatus(e.target.value)}
                disabled={pending}
              >
                {STATUS_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {targetKind === 'tag' && (
            <div>
              <label htmlFor="bc-tag" className="text-xs font-medium">
                Tag
              </label>
              <input
                id="bc-tag"
                type="text"
                className={inputClass}
                value={targetTag}
                placeholder="ej: piloto"
                onChange={e => setTargetTag(e.target.value)}
                disabled={pending}
              />
            </div>
          )}
          <Button
            disabled={
              pending
              || !title.trim()
              || !message.trim()
              || (targetKind === 'tag' && !targetTag.trim())
            }
            onClick={send}
          >
            Enviar alerta
          </Button>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h2 className="font-semibold">Enviadas recientemente</h2>
        {props.recent.length === 0
          ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Todavía no enviaste alertas.
              </p>
            )
          : (
              <ul className="mt-2 space-y-2 text-sm">
                {props.recent.map(b => (
                  <li
                    key={b.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <span className="font-medium">{b.title}</span>
                      <span className="ml-2 truncate text-muted-foreground">
                        {b.message}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline">{b.severity}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(b.createdAt).toLocaleString('es-CO', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </div>
  );
}
