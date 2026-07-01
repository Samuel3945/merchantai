-- Owner can block an unwanted WhatsApp number from the Conversaciones inbox.
-- When blocked, the bot must stay silent even if it is not paused. n8n reads
-- this flag (alongside bot_paused) from the /api/agent/conversations/upsert
-- response to decide whether to answer.
ALTER TABLE "conversations" ADD COLUMN "blocked" boolean DEFAULT false NOT NULL;
