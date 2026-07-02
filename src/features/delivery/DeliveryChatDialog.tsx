'use client';

import type { MessageRow } from '@/features/conversations/actions';
import { SendIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast-store';
import { MessageBubble } from '@/features/conversations/MessageThread';
import {
  getDeliveryConversation,
  sendDeliveryConversationMessage,
} from './delivery-chat-actions';

// Masked chat panel for one delivery: the courier talks to the customer through
// the business WhatsApp number, reusing the customer's existing bot thread. The
// server derives + authorizes the conversation from the order id (the courier
// only ever passes the order id it owns — see delivery-chat-actions.ts).
export function DeliveryChatDialog({
  orderId,
  customerName,
  onClose,
}: {
  orderId: string;
  customerName: string | null;
  onClose: () => void;
}) {
  // null → still loading; [] → loaded/empty. `hasConversation` false means the
  // customer has no WhatsApp thread yet (manual order): we show the fallback,
  // not an empty composer.
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [hasConversation, setHasConversation] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    getDeliveryConversation(orderId)
      .then((data) => {
        if (cancelled) {
          return;
        }
        setHasConversation(data.conversationId !== null);
        setMessages(data.messages);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setMessages([]);
        toast.error('No se pudo cargar el chat');
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

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
      const msg = await sendDeliveryConversationMessage(orderId, text);
      setMessages(prev => (prev ? [...prev, msg] : [msg]));
      setDraft('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo enviar el mensaje');
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="flex h-[70vh] max-w-md flex-col gap-0 p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>{`Chat con ${customerName ?? 'el cliente'}`}</DialogTitle>
          <DialogDescription>
            Le escribís por el WhatsApp del negocio. El bot se pausa mientras
            atendés.
          </DialogDescription>
        </DialogHeader>

        <div
          ref={scrollRef}
          className="
            scrollbar-subtle flex-1 space-y-2 overflow-y-auto px-4 py-3
          "
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
          {messages !== null && !hasConversation && (
            <div className="
              flex h-full flex-col items-center justify-center gap-1 px-6
              text-center text-sm text-muted-foreground
            "
            >
              <span className="text-2xl">💬</span>
              <p>
                Este cliente todavía no tiene una conversación de WhatsApp con el
                negocio. Usá el botón «WhatsApp» para escribirle.
              </p>
            </div>
          )}
          {messages !== null && hasConversation && messages.length === 0 && (
            <div className="
              flex h-full items-center justify-center text-sm
              text-muted-foreground
            "
            >
              Todavía no hay mensajes en esta conversación.
            </div>
          )}
          {hasConversation
            && messages?.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
        </div>

        {hasConversation && (
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
              disabled={sending || messages === null}
              placeholder="Escribí tu mensaje…"
              className="
                h-10 flex-1 rounded-md border border-border bg-background px-3
                text-sm
                disabled:opacity-60
              "
            />
            <Button
              size="sm"
              disabled={sending || messages === null || !draft.trim()}
              onClick={() => void handleSend()}
              aria-label="Enviar mensaje"
            >
              <SendIcon className="size-4" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
