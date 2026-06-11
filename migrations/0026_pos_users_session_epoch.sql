-- Single-active-device sessions for pos_users (email/password login path).
-- pos_tokens already has session_epoch; this adds the same column to pos_users
-- so that logging in on a new device bumps the epoch and revokes prior sessions.
ALTER TABLE "pos_users" ADD COLUMN "session_epoch" integer DEFAULT 0 NOT NULL;
