-- Phase 3: add enum values for the handover flow.
-- ADR-2: MUST run in its own transaction BEFORE migration 0053, because
-- PostgreSQL forbids using a newly-added enum value in the same transaction
-- that added it (error: "unsafe use of new value … of enum type").
-- Drizzle runs each migration file as a separate transaction, so the two-file
-- split is the safe, correct approach.
ALTER TYPE "public"."treasury_account_type" ADD VALUE 'transito';--> statement-breakpoint
ALTER TYPE "public"."treasury_movement_type" ADD VALUE 'handover';
