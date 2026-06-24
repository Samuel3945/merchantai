-- Rename the "fiado" domain to "credito" (store-credit, shown as "Crédito" in
-- the UI). A pure terminology rename: the tables, enum types, the cash-movement
-- enum value, the self-describing columns/indexes, and the stored free-text
-- method/payment labels all move from "fiado" to "credito".
--
-- Nothing is dropped — every object is RENAMEd in place, so existing rows and
-- foreign keys survive untouched. ALTER TYPE ... RENAME VALUE relabels every
-- row that used the old enum value instantly (values are stored by OID).
--
-- Hand-written (not drizzle-kit generated): a generated diff would DROP+CREATE
-- the tables (data loss) instead of RENAME, and would re-emit the frozen
-- baseline snapshot drift (see 0064 / Schema.ts). The meta snapshots are left
-- as-is on purpose.
--
-- prod: node scripts/db-migrate.mjs
ALTER TYPE "fiado_status" RENAME TO "credito_status";
--> statement-breakpoint
ALTER TYPE "fiado_movement_type" RENAME TO "credito_movement_type";
--> statement-breakpoint
ALTER TYPE "cash_movement_type" RENAME VALUE 'fiado_payment' TO 'credito_payment';
--> statement-breakpoint
ALTER TABLE "fiados" RENAME TO "creditos";
--> statement-breakpoint
ALTER TABLE "fiado_movements" RENAME TO "credito_movements";
--> statement-breakpoint
ALTER TABLE "credito_movements" RENAME COLUMN "fiado_id" TO "credito_id";
--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" RENAME COLUMN "resolution_fiado_id" TO "resolution_credito_id";
--> statement-breakpoint
ALTER INDEX "fiados_org_status_idx" RENAME TO "creditos_org_status_idx";
--> statement-breakpoint
ALTER INDEX "fiados_org_due_date_idx" RENAME TO "creditos_org_due_date_idx";
--> statement-breakpoint
ALTER INDEX "fiados_customer_idx" RENAME TO "creditos_customer_idx";
--> statement-breakpoint
ALTER INDEX "fiados_sale_unique_idx" RENAME TO "creditos_sale_unique_idx";
--> statement-breakpoint
ALTER INDEX "fiado_movements_fiado_created_idx" RENAME TO "credito_movements_credito_created_idx";
--> statement-breakpoint
ALTER INDEX "fiado_movements_org_type_created_idx" RENAME TO "credito_movements_org_type_created_idx";
--> statement-breakpoint
UPDATE "sales" SET "payment_type" = 'credito' WHERE "payment_type" = 'fiado';
--> statement-breakpoint
UPDATE "sale_payments" SET "method" = 'credito' WHERE "method" = 'fiado';
--> statement-breakpoint
UPDATE "credito_movements" SET "method" = 'credito' WHERE "method" = 'fiado';
--> statement-breakpoint
UPDATE "transfer_reconciliations" SET "method" = 'credito' WHERE "method" = 'fiado';
--> statement-breakpoint
UPDATE "payment_methods" SET "name" = 'Crédito' WHERE "name" = 'Fiado';
