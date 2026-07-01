// Shared, framework-agnostic helpers for the Conversaciones inbox. Imported by
// BOTH the server action (src/features/conversations/actions.ts) and the client
// component (ConversationsClient.tsx), so this module must stay free of
// 'use server' / 'use client' directives and of any DB / React imports.

// How long the bot stays paused when the owner takes over ("Atender yo"). After
// this window the bot auto-resumes on the next inbound message — the guarantee
// that a conversation is never left "en visto" forever. The auto-resume itself
// lives in POST /api/agent/conversations/upsert.
export const PAUSE_MINUTES = 30;

// The four visible states an owner can see in the inbox.
//   bot       → "Bot activo" (the agent answers)
//   attending → "Atendiendo vos" (a human took over; bot silent, auto-resumes)
//   paused    → "Pausado (se reactiva HH:MM)" (bot paused, no human attached)
//   blocked   → "Bloqueado" (number blocked; bot always silent)
export type ConversationControlStatus = 'bot' | 'attending' | 'paused' | 'blocked';

export type ConversationControlState = {
  blocked: boolean;
  botPaused: boolean;
  /** ISO string or null. */
  botPausedUntil: string | null;
  attendedBy: string;
};

/** True while a pause window is still open (bot silent, will auto-resume). */
export function isPauseActive(
  state: Pick<ConversationControlState, 'botPaused' | 'botPausedUntil'>,
  now: number = Date.now(),
): boolean {
  if (!state.botPaused || !state.botPausedUntil) {
    return false;
  }
  const until = Date.parse(state.botPausedUntil);
  return Number.isFinite(until) && until > now;
}

/**
 * Deterministic status for the badge. Priority: blocked > (human takeover)
 * > (bot-initiated pause) > bot. A human takeover ("Atender yo") sets both a
 * pause window AND attendedBy, so it resolves to `attending` and the UI still
 * shows the auto-resume time. Once the pause window lapses (and after the bot
 * auto-resumes, which also clears attendedBy) the row falls back to `bot`.
 */
export function conversationControlStatus(
  state: ConversationControlState,
  now: number = Date.now(),
): ConversationControlStatus {
  if (state.blocked) {
    return 'blocked';
  }
  const pausedActive = isPauseActive(state, now);
  const humanAttending = state.attendedBy !== 'bot';
  if (pausedActive && humanAttending) {
    return 'attending';
  }
  if (pausedActive) {
    return 'paused';
  }
  if (humanAttending) {
    return 'attending';
  }
  return 'bot';
}
