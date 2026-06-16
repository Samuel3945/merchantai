-- Phase 3: add enum values for the handover flow.
-- NOTE: drizzle-orm's node-postgres migrator runs all pending migrations in ONE
-- transaction, so 0052 does NOT commit before 0053 (the earlier ADR-2 note was
-- wrong). PostgreSQL 12+ allows ADD VALUE inside a transaction, but the new value
-- cannot be USED as an enum literal until commit — 0053 sidesteps that by
-- comparing type::text instead. IF NOT EXISTS keeps this safe to re-run after a
-- failed batch or a manual hotfix.
ALTER TYPE "public"."treasury_account_type" ADD VALUE IF NOT EXISTS 'transito';--> statement-breakpoint
ALTER TYPE "public"."treasury_movement_type" ADD VALUE IF NOT EXISTS 'handover';
