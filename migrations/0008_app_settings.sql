-- app_settings — per-org generic key/value store.
--
-- Drives the onboarding gate (onboarding_completed), business profile fields
-- (business_name, business_type, etc.) and any per-org preference that doesn't
-- justify a dedicated table. Value is text so callers serialize JSON when needed.

CREATE TABLE IF NOT EXISTS "app_settings" (
  "organization_id" text NOT NULL,
  "key" text NOT NULL,
  "value" text DEFAULT '' NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "app_settings_pk" PRIMARY KEY ("organization_id", "key")
);
