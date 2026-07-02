'use client';

// Shared, presentational chat primitives for the WhatsApp message thread. Lives
// here (not inside ConversationsClient) so BOTH the admin inbox (ThreadPane) and
// the courier-scoped delivery chat (features/delivery/DeliveryChatDialog) render
// identical bubbles instead of duplicating the customer/bot/courier styling.

import type { MessageRow } from './actions';
import { cn } from '@/utils/Helpers';

const timeFmt = new Intl.DateTimeFormat('es-CO', {
  hour: '2-digit',
  minute: '2-digit',
});

// WhatsApp-style bubble: inbound (customer) hugs the left in a neutral tone;
// outbound hugs the right, colored by who sent it (bot vs. a human agent) so
// the two are visually distinguishable at a glance.
export function MessageBubble({ msg }: { msg: MessageRow }) {
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
