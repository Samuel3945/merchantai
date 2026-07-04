-- Per-person POS PIN with self-set activation link (Option B).
--
-- Each cashier gets their OWN PIN so nobody can impersonate another operator.
-- The admin never sees or sets the PIN: they send a WhatsApp ACTIVATION LINK and
-- the employee sets their own PIN through it. These columns back that flow plus a
-- wrong-PIN lockout. All non-destructive: every column is nullable or defaulted,
-- so existing rows keep working (an empty `pin` simply reads as "pendiente de
-- activar").
--
--   activation_token      SHA-256 HASH of the raw one-time token (never the raw
--                         token — that lives only inside the link we send). A
--                         deterministic hash lets us look the row up by equality
--                         while a DB leak cannot be replayed.
--   activation_expires_at when the link stops working (set to now + 72h on send).
--   pin_failed_attempts   consecutive wrong PIN tries at the shared-caja gate.
--   pin_locked_until      when set to a future instant the cashier is locked out
--                         (5 wrong tries → locked 5 min). A correct PIN or a fresh
--                         activation clears both counters.
ALTER TABLE "pos_users" ADD COLUMN "activation_token" text;--> statement-breakpoint
ALTER TABLE "pos_users" ADD COLUMN "activation_expires_at" timestamptz;--> statement-breakpoint
ALTER TABLE "pos_users" ADD COLUMN "pin_failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_users" ADD COLUMN "pin_locked_until" timestamptz;
