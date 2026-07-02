'use client';

import type { ConversationRow, MessageRow } from './actions';
import type { ConversationControlStatus } from './status';
import { ArrowLeftIcon, SearchIcon, SendIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Toaster } from '@/components/ui/toast';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/utils/Helpers';
import {
  listConversationMessages,
  pauseConversationBot,
  resumeConversationBot,
  sendConversationMessage,
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

const BADGE: Record<
  ConversationControlStatus,
  { label: string; cls: string }
> = {
  bot: { label: 'Bot activo', cls: 'bg-emerald-500/10 text-emerald-600' },
  attending: { label: 'Atendiendo vos', cls: 'bg-sky-500/10 text-sky-600' },
  paused: { label: 'Pausado', cls: 'bg-amber-500/10 text-amber-600' },
  blocked: { label: 'Bloqueado', cls: 'bg-destructive/10 text-destructive' },
};

type Segment = 'all' | ConversationControlStatus;

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'all', label: 'Todas' },
  { key: 'bot', label: 'Bot' },
  { key: 'attending', label: 'Atendiendo yo' },
  { key: 'paused', label: 'Pausadas' },
  { key: 'blocked', label: 'Bloqueadas' },
];

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
  const [search, setSearch] = useState('');
  const [segment, setSegment] = useState<Segment>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  // Segment counts for the filter tabs, derived from the shared status helper.
  const counts = useMemo(() => {
    const c: Record<Segment, number> = {
      all: rows.length,
      bot: 0,
      attending: 0,
      paused: 0,
      blocked: 0,
    };
    for (const row of rows) {
      c[conversationControlStatus(row, now)] += 1;
    }
    return c;
  }, [rows, now]);

  // Client-side filter over the already-loaded list: segment tab + name/phone
  // search combined.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (segment !== 'all' && conversationControlStatus(row, now) !== segment) {
        return false;
      }
      if (!q) {
        return true;
      }
      const name = row.customerName?.toLowerCase() ?? '';
      const phone = phoneFromJid(row.remoteJid).toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [rows, search, segment, now]);

  const selected = rows.find(r => r.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div className="
        rounded-lg border border-brand/30 bg-brand-soft/30 px-4 py-3 text-sm
        text-muted-foreground
      "
      >
        Cuando respondés o tomás una conversación, el bot se pausa y
        {' '}
        <strong className="text-foreground">
          se reactiva solo a los
          {' '}
          {PAUSE_MINUTES}
          {' '}
          min
        </strong>
        {' '}
        (o antes si tocás «Conversación finalizada»). Ninguna conversación queda
        en visto para siempre.
      </div>

      <div className="
        flex h-[70vh] min-h-[560px] overflow-hidden rounded-lg border bg-card
      "
      >
        {/* Left pane — conversation list. Hidden on mobile once a row is
            selected (the thread pane takes over the whole viewport). */}
        <div
          className={cn(
            `
              flex w-full flex-col
              md:w-[340px] md:shrink-0 md:border-r
            `,
            selectedId && `
              hidden
              md:flex
            `,
          )}
        >
          <div className="border-b p-3">
            <div className="relative">
              <SearchIcon className="
                pointer-events-none absolute top-1/2 left-2.5 size-4
                -translate-y-1/2 text-muted-foreground
              "
              />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Buscar por nombre o teléfono…"
                className="
                  h-9 w-full rounded-md border border-border bg-background pr-3
                  pl-8 text-sm
                "
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SEGMENTS.map(s => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSegment(s.key)}
                  className={cn(
                    `
                      rounded-full border px-2.5 py-1 text-xs font-medium
                      transition-colors
                    `,
                    segment === s.key
                      ? 'border-brand bg-brand-soft text-brand'
                      : `
                        border-border text-muted-foreground
                        hover:text-foreground
                      `,
                  )}
                >
                  {s.label}
                  {' '}
                  <span className="tabular-nums opacity-70">{counts[s.key]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="scrollbar-subtle flex-1 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="
                px-4 py-10 text-center text-sm text-muted-foreground
              "
              >
                {rows.length === 0
                  ? 'Todavía no hay conversaciones. Cuando tus clientes escriban por WhatsApp aparecerán acá.'
                  : 'No encontramos conversaciones con ese filtro.'}
              </div>
            )}

            {filtered.map((row) => {
              const status = conversationControlStatus(row, now);
              const badge = BADGE[status];
              const pausedActive = isPauseActive(row, now);

              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  className={cn(
                    `
                      flex w-full flex-col gap-1 border-b px-4 py-3 text-left
                      transition-colors
                      last:border-b-0
                    `,
                    row.id === selectedId
                      ? 'bg-brand-soft/40'
                      : 'hover:bg-muted/50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {row.customerName ?? phoneFromJid(row.remoteJid)}
                    </span>
                    <span className={cn(
                      `
                        shrink-0 rounded-full px-2 py-0.5 text-[11px]
                        font-semibold
                      `,
                      badge.cls,
                    )}
                    >
                      {badge.label}
                    </span>
                  </div>

                  <div className="
                    flex items-center justify-between gap-2 text-xs
                    text-muted-foreground
                  "
                  >
                    <span className="truncate">{phoneFromJid(row.remoteJid)}</span>
                    {row.lastMessageAt && (
                      <span
                        suppressHydrationWarning
                        className="shrink-0 tabular-nums"
                      >
                        {timeFmt.format(new Date(row.lastMessageAt))}
                      </span>
                    )}
                  </div>

                  {pausedActive && row.botPausedUntil && (
                    <div
                      suppressHydrationWarning
                      className="text-xs font-medium text-amber-600"
                    >
                      {reactivationLabel(row.botPausedUntil, now)}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right pane — thread. Hidden on mobile until a row is selected. */}
        <div
          className={cn(
            'flex w-full min-w-0 flex-1 flex-col',
            !selectedId && `
              hidden
              md:flex
            `,
          )}
        >
          {selected
            ? (
                <ThreadPane
                  key={selected.id}
                  row={selected}
                  now={now}
                  busy={pendingId === selected.id}
                  onBack={() => setSelectedId(null)}
                  onPause={() =>
                    run(
                      selected.id,
                      () => pauseConversationBot(selected.id),
                      `Atendés vos · el bot vuelve en ${PAUSE_MINUTES} min`,
                    )}
                  onResume={() =>
                    run(
                      selected.id,
                      () => resumeConversationBot(selected.id),
                      'Conversación finalizada · el bot responde de nuevo',
                    )}
                  onBlock={() => handleBlock(selected)}
                  onUnblock={() =>
                    run(
                      selected.id,
                      () => setConversationBlocked(selected.id, false),
                      'Número desbloqueado',
                    )}
                  onPatched={patch =>
                    setRows(rs =>
                      rs.map(r => (r.id === selected.id ? { ...r, ...patch } : r)),
                    )}
                />
              )
            : (
                <div className="
                  flex flex-1 items-center justify-center text-sm
                  text-muted-foreground
                "
                >
                  Seleccioná una conversación
                </div>
              )}
        </div>
      </div>

      <Toaster />
    </div>
  );
}

// Header + control actions + message history + composer for the currently
// selected conversation. Remounts (via the `key={row.id}` on the caller) when
// the selection changes, so its message-thread state never leaks between
// conversations.
function ThreadPane({
  row,
  now,
  busy,
  onBack,
  onPause,
  onResume,
  onBlock,
  onUnblock,
  onPatched,
}: {
  row: ConversationRow;
  now: number;
  busy: boolean;
  onBack: () => void;
  onPause: () => void;
  onResume: () => void;
  onBlock: () => void;
  onUnblock: () => void;
  onPatched: (patch: Partial<ConversationRow>) => void;
}) {
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const status = conversationControlStatus(row, now);
  const badge = BADGE[status];
  const pausedActive = isPauseActive(row, now);

  // `row.id` never changes within a mount — the caller remounts ThreadPane via
  // `key={row.id}` on selection change — so this fetch runs exactly once per
  // conversation and `messages` starts out `null` (its initial state) already.
  useEffect(() => {
    let cancelled = false;
    listConversationMessages(row.id)
      .then((data) => {
        if (!cancelled) {
          setMessages(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMessages([]);
          toast.error('No se pudo cargar el historial de mensajes');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  // Auto-scroll to the latest message whenever the thread loads or grows.
  useEffect(() => {
    if (messages && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function handleSend(): Promise<void> {
    const text = draft.trim();
    if (!text || sending) {
      return;
    }
    setSending(true);
    try {
      const { message, conversation } = await sendConversationMessage(row.id, text);
      setMessages(prev => (prev ? [...prev, message] : [message]));
      setDraft('');
      // Reflect the implicit takeover (auto-pause) the send performed: badge
      // flips to "Atendiendo vos" and the 30-min countdown starts.
      onPatched(conversation);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo enviar el mensaje');
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Volver a la lista"
          className="
            flex size-8 shrink-0 items-center justify-center rounded-md
            text-muted-foreground
            hover:text-foreground
            md:hidden
          "
        >
          <ArrowLeftIcon className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {row.customerName ?? phoneFromJid(row.remoteJid)}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {phoneFromJid(row.remoteJid)}
          </div>
        </div>
        <span className={cn(
          'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold',
          badge.cls,
        )}
        >
          {badge.label}
        </span>
      </div>

      <div className="
        flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2
      "
      >
        {row.blocked
          ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={onUnblock}>
                Desbloquear
              </Button>
            )
          : (
              <>
                {pausedActive
                  ? (
                      // Explicit finish: hand the conversation back to the bot
                      // immediately (resumeConversationBot), instead of waiting
                      // out the 30-min auto-reactivation window.
                      <Button size="sm" disabled={busy} onClick={onResume}>
                        Conversación finalizada
                      </Button>
                    )
                  : (
                      // Take over WITHOUT sending a message yet (a manual reply
                      // auto-takes-over on its own — see sendConversationMessage).
                      <Button size="sm" variant="secondary" disabled={busy} onClick={onPause}>
                        Atender yo
                      </Button>
                    )}
                <Button size="sm" variant="ghost" disabled={busy} onClick={onBlock}>
                  Bloquear
                </Button>
              </>
            )}
        {pausedActive && row.botPausedUntil && (
          <span
            suppressHydrationWarning
            className="text-xs font-medium text-amber-600"
          >
            {reactivationLabel(row.botPausedUntil, now)}
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="scrollbar-subtle flex-1 space-y-2 overflow-y-auto px-4 py-3"
      >
        {messages === null && (
          <div className="
            flex h-full items-center justify-center text-sm
            text-muted-foreground
          "
          >
            Cargando mensajes…
          </div>
        )}
        {messages?.length === 0 && (
          <div className="
            flex h-full items-center justify-center text-sm
            text-muted-foreground
          "
          >
            Todavía no hay mensajes en esta conversación.
          </div>
        )}
        {messages?.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
      </div>

      <div className="flex items-center gap-2 border-t p-3">
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={sending}
          placeholder="Escribí tu respuesta…"
          className="
            h-10 flex-1 rounded-md border border-border bg-background px-3
            text-sm
            disabled:opacity-60
          "
        />
        <Button
          size="sm"
          disabled={sending || !draft.trim()}
          onClick={() => void handleSend()}
          aria-label="Enviar mensaje"
        >
          <SendIcon className="size-4" />
        </Button>
      </div>
    </>
  );
}

// WhatsApp-style bubble: inbound (customer) hugs the left in a neutral tone;
// outbound hugs the right, colored by who sent it (bot vs. a human agent) so
// the two are visually distinguishable at a glance.
function MessageBubble({ msg }: { msg: MessageRow }) {
  const isCustomer = msg.senderType === 'customer';
  const isBot = msg.senderType === 'bot';

  return (
    <div className={cn('flex', isCustomer ? 'justify-start' : 'justify-end')}>
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-xs',
          isCustomer && 'rounded-bl-sm bg-muted text-foreground',
          isBot && 'rounded-br-sm bg-emerald-500/15 text-foreground',
          !isCustomer && !isBot && 'rounded-br-sm bg-sky-500/15 text-foreground',
        )}
      >
        <p className="wrap-break-word whitespace-pre-wrap">
          {msg.body ?? '(sin contenido)'}
        </p>
        <div className="
          mt-1 flex items-center justify-end gap-1 text-[10px]
          text-muted-foreground
        "
        >
          {!isCustomer && (
            <span className="font-medium">{isBot ? 'Bot' : 'Vos'}</span>
          )}
          <span suppressHydrationWarning>
            {timeFmt.format(new Date(msg.createdAt))}
          </span>
        </div>
      </div>
    </div>
  );
}
