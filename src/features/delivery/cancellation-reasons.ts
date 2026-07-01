// Shared source of truth for delivery cancellation reasons. Kept framework-free
// (no 'use server', no DB) so it can be imported by the zod validation schema,
// the server action (event note + customer message), AND the client board UI.
//
// A cancellation carries a preset reason key; 'otro' additionally accepts a free
// text. The customer-facing WhatsApp copy DEPENDS on the reason (CANCEL_REASON_
// MESSAGES) so the person waiting for the order gets a message that actually
// explains what happened, not a generic "cancelado".

// The preset keys, as a const tuple so `z.enum(CANCEL_REASON_KEYS)` type-checks.
export const CANCEL_REASON_KEYS = [
  'cliente_no_responde',
  'direccion_incorrecta',
  'cliente_cancelo',
  'sin_stock',
  'fuera_de_cobertura',
  'otro',
] as const;

export type CancelReasonKey = (typeof CANCEL_REASON_KEYS)[number];

// Human labels (Spanish) shown in the reason picker and written to the event
// timeline. Order mirrors CANCEL_REASON_KEYS.
export const CANCEL_REASON_LABELS: Record<CancelReasonKey, string> = {
  cliente_no_responde: 'El cliente no responde',
  direccion_incorrecta: 'Dirección incorrecta',
  cliente_cancelo: 'El cliente canceló',
  sin_stock: 'Sin stock',
  fuera_de_cobertura: 'Fuera de cobertura',
  otro: 'Otro motivo',
};

// The customer-facing WhatsApp text per reason. Each one explains the situation
// and invites the customer to write back, so a cancellation never dead-ends.
export const CANCEL_REASON_MESSAGES: Record<CancelReasonKey, string> = {
  cliente_no_responde:
    'Intentamos entregar tu pedido pero no logramos contactarte, así que lo cancelamos. Escríbenos por aquí para reprogramar la entrega. 🛵',
  direccion_incorrecta:
    'No pudimos completar la entrega porque la dirección no coincide. Escríbenos para confirmar tus datos y reprogramar el pedido. 📍',
  cliente_cancelo:
    'Confirmamos la cancelación de tu pedido. Si fue un error o querés retomarlo, escribinos por aquí. 🙌',
  sin_stock:
    'Lamentablemente uno de los productos de tu pedido se agotó y tuvimos que cancelarlo. Escríbenos y te ofrecemos una alternativa. 🙏',
  fuera_de_cobertura:
    'Tu dirección está fuera de nuestra zona de cobertura de domicilios, así que no pudimos completar la entrega. Escríbenos para ver otras opciones. 🛵',
  otro:
    'Tu pedido fue cancelado. Si tenés dudas, escribinos por aquí y te ayudamos. 🙌',
};

// The ordered list the UI renders (key + label).
export const CANCEL_REASONS: ReadonlyArray<{ key: CancelReasonKey; label: string }>
  = CANCEL_REASON_KEYS.map(key => ({ key, label: CANCEL_REASON_LABELS[key] }));

export function isCancelReasonKey(value: unknown): value is CancelReasonKey {
  return (
    typeof value === 'string'
    && (CANCEL_REASON_KEYS as readonly string[]).includes(value)
  );
}

// The note persisted on the status_change event. For 'otro' the free text is the
// real reason, so it is appended; for the other reasons an optional free text is
// appended after an em dash when present.
export function cancelReasonEventNote(
  key: CancelReasonKey,
  freeText?: string | null,
): string {
  const label = CANCEL_REASON_LABELS[key];
  const extra = freeText?.trim();
  if (extra) {
    return `${label} — ${extra}`;
  }
  return label;
}

// The reason-specific customer WhatsApp copy. Falls back to the generic 'otro'
// message for an unknown key (defensive; the schema already constrains it).
export function cancelReasonCustomerMessage(key: string): string {
  return isCancelReasonKey(key)
    ? CANCEL_REASON_MESSAGES[key]
    : CANCEL_REASON_MESSAGES.otro;
}
