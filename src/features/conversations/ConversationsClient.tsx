'use client';

import type { ConversationRow } from './actions';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast-store';
import {
  pauseConversationBot,
  resumeConversationBot,
  setConversationBlocked,
} from './actions';
import {
  conversationControlStatus,
  isPauseActive,
  PAUSE_MINUTES,
} from './status';

const timeFmt = new Intl.DateTimeFormat('es-CO', {
  hour: '2-digit',
  minute: '2-digit',
});

const dateTimeFmt = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const BADGE: Record<
  ReturnType<typeof conversationControlStatus>,
  { label: string; cls: string }
> = {
  bot: { label: 'Bot activo', cls: 'bg-emerald-500/10 text-emerald-600' },
  attending: { label: 'Atendiendo vos', cls: 'bg-sky-500/10 text-sky-600' },
  paused: { label: 'Pausado', cls: 'bg-amber-500/10 text-amber-600' },
  blocked: { label: 'Bloqueado', cls: 'bg-destructive/10 text-destructive' },
};

// "5730012345@s.whatsapp.net" → "+5730012345"; group jids or non-numeric ids
// fall back to the raw local part.
function phoneFromJid(remoteJid: string): string {
  const local = remoteJid.split('@')[0] ?? remoteJid;
  return /^\d+$/.test(local) ? `+${local}` : local;
}

function reactivationLabel(untilIso: string, now: number): string {
  const until = Date.parse(untilIso);
  const mins = Math.max(0, Math.ceil((until - now) / 60_000));
  return `Se reactiva ${timeFmt.format(new Date(until))} · en ${mins} min`;
}

export function ConversationsClient({ initial }: { initial: ConversationRow[] }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Ticks the "se reactiva en N min" countdown and lets an elapsed pause fall
  // back to "Bot activo" on its own, mirroring the server-side auto-resume.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  async function run(
    id: string,
    action: () => Promise<Partial<ConversationRow>>,
    okMsg: string,
  ): Promise<void> {
    setPendingId(id);
    try {
      const patch = await action();
      setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));
      toast.success(okMsg);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo actualizar');
    } finally {
      setPendingId(null);
    }
  }

  const handleBlock = async (row: ConversationRow) => {
    const ok = await confirm({
      title: `¿Bloquear ${row.customerName ?? phoneFromJid(row.remoteJid)}?`,
      description:
        'El bot dejará de responderle a este número hasta que lo desbloquees. Podés revertirlo cuando quieras.',
      confirmText: 'Bloquear',
      tone: 'destructive',
    });
    if (!ok) {
      return;
    }
    await run(row.id, () => setConversationBlocked(row.id, true), 'Número bloqueado');
  };

  return (
    <div className="space-y-4">
      <div className="
        rounded-lg border border-brand/30 bg-brand-soft/30 px-4 py-3 text-sm
        text-muted-foreground
      "
      >
        Cuando tomás una conversación, el bot se pausa y
        {' '}
        <strong className="text-foreground">
          se reactiva solo a los
          {' '}
          {PAUSE_MINUTES}
          {' '}
          min
        </strong>
        {' '}
        (o antes si tocás «Reactivar bot ahora»). Ninguna conversación queda en
        visto para siempre.
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="
          grid grid-cols-[1fr_auto] gap-2 border-b bg-muted/50 px-4 py-2 text-xs
          font-medium text-muted-foreground uppercase
        "
        >
          <div>Conversación</div>
          <div className="text-right">Acciones</div>
        </div>

        {rows.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            Todavía no hay conversaciones. Cuando tus clientes escriban por
            WhatsApp aparecerán acá.
          </div>
        )}

        <div className="scrollbar-subtle max-h-[70vh] overflow-y-auto">
          {rows.map((row) => {
            const status = conversationControlStatus(row, now);
            const badge = BADGE[status];
            const pausedActive = isPauseActive(row, now);
            const busy = pendingId === row.id;

            return (
              <div
                key={row.id}
                className="
                  grid grid-cols-[1fr_auto] items-center gap-3 border-b px-4
                  py-3
                  last:border-b-0
                "
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">
                      {row.customerName ?? phoneFromJid(row.remoteJid)}
                    </span>
                    <span className={`
                      shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold
                      ${badge.cls}
                    `}
                    >
                      {badge.label}
                    </span>
                  </div>

                  <div className="
                    mt-0.5 flex flex-wrap items-center gap-x-2 text-xs
                    text-muted-foreground
                  "
                  >
                    {row.customerName && (
                      <span className="truncate">{phoneFromJid(row.remoteJid)}</span>
                    )}
                    {row.lastMessageAt && (
                      <span suppressHydrationWarning>
                        Último mensaje
                        {' '}
                        {dateTimeFmt.format(new Date(row.lastMessageAt))}
                      </span>
                    )}
                  </div>

                  {pausedActive && row.botPausedUntil && (
                    <div
                      suppressHydrationWarning
                      className="mt-1 text-xs font-medium text-amber-600"
                    >
                      {reactivationLabel(row.botPausedUntil, now)}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap justify-end gap-2">
                  {row.blocked
                    ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() =>
                            run(
                              row.id,
                              () => setConversationBlocked(row.id, false),
                              'Número desbloqueado',
                            )}
                        >
                          Desbloquear
                        </Button>
                      )
                    : (
                        <>
                          {pausedActive
                            ? (
                                <Button
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    run(
                                      row.id,
                                      () => resumeConversationBot(row.id),
                                      'El bot volvió a responder',
                                    )}
                                >
                                  Reactivar bot ahora
                                </Button>
                              )
                            : (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    run(
                                      row.id,
                                      () => pauseConversationBot(row.id),
                                      `Atendés vos · el bot vuelve en ${PAUSE_MINUTES} min`,
                                    )}
                                >
                                  Atender yo
                                </Button>
                              )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => handleBlock(row)}
                          >
                            Bloquear
                          </Button>
                        </>
                      )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
