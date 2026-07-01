-- Wompi top-up payments: track the pending/approved/declined lifecycle so AI
-- credits are granted only after the gateway confirms payment (webhook +
-- authoritative query), instead of granting synchronously at checkout time
-- like the old flow. `reference` is the Wompi checkout reference and its
-- unique index is the idempotency key for the credit grant.
ALTER TABLE "top_ups" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;
UPDATE "top_ups" SET "status" = 'approved';
ALTER TABLE "top_ups" ADD COLUMN "reference" text;
ALTER TABLE "top_ups" ADD COLUMN "wompi_transaction_id" text;
CREATE UNIQUE INDEX "top_ups_reference_unique_idx" ON "top_ups" ("reference");
