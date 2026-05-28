-- audit_logs — append-only audit trail of mutations.
--
-- Populated by the logAction() helper after every important server-action /
-- API mutation. actor_type distinguishes Clerk admins ('user'), POS cashiers
-- ('cashier'), cron jobs ('system'), and external integrations ('api').
-- before/after carry JSON snapshots; either may be NULL (creations have no
-- before, deletions have no after). A daily purge cron deletes rows older
-- than 365 days to keep the table bounded.

CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'cashier', 'system', 'api');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "actor_type" "audit_actor_type" NOT NULL,
  "actor_id" text NOT NULL,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text,
  "before" jsonb,
  "after" jsonb,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "ip" text,
  "user_agent" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_logs_org_created_idx"
  ON "audit_logs" USING btree ("organization_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_logs_org_action_idx"
  ON "audit_logs" USING btree ("organization_id", "action");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_logs_org_entity_idx"
  ON "audit_logs" USING btree ("organization_id", "entity_type", "entity_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_logs_org_actor_idx"
  ON "audit_logs" USING btree ("organization_id", "actor_id");
