ALTER TABLE "treasury_movements" ADD COLUMN "transfer_reconciliation_id" uuid;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_transfer_reconciliation_id_transfer_reconciliations_id_fk" FOREIGN KEY ("transfer_reconciliation_id") REFERENCES "public"."transfer_reconciliations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_movements_transfer_recon_unique" ON "treasury_movements" USING btree ("transfer_reconciliation_id");
