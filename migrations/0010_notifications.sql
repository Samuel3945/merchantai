-- notifications — per-organization notification feed.
--
-- Replaces ad-hoc badges (cash fraud alerts, expiration tier counts) with a
-- unified inbox surfaced by the dashboard bell. Kinds are append-only: new
-- alert types add a value to notification_kind. Severity drives UI emphasis
-- (the bell pulses red when any unread row has severity='high').

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "min_stock" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TYPE "public"."notification_kind" AS ENUM(
  'cash_difference',
  'low_stock',
  'expiring_soon',
  'fiado_overdue',
  'sale_alert'
);--> statement-breakpoint

CREATE TYPE "public"."notification_severity" AS ENUM('low', 'mid', 'high');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "kind" "notification_kind" NOT NULL,
  "severity" "notification_severity" DEFAULT 'mid' NOT NULL,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "read" boolean DEFAULT false NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "notifications_org_created_idx"
  ON "notifications" USING btree ("organization_id","created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "notifications_org_unread_idx"
  ON "notifications" USING btree ("organization_id","created_at")
  WHERE "read" = false;
