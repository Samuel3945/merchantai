-- Customer detail (ficha de cliente): link a sale to the customer it is
-- attributed to. Nullable — a plain anonymous POS sale keeps this NULL. The FK
-- is ON DELETE SET NULL so archiving/purging a customer never deletes their
-- sales, it just unlinks them. An index on (organization_id, customer_id) backs
-- the per-customer sales scan the detail view runs.
--
-- Going forward the column is stamped inside the sale transaction at every path
-- that already knows the customer: invoice-tagged sales (post-sale-side-effects
-- threads the upserted customer id), fiado/delivery sales (createSaleForOrg
-- receives the customerId). Historical rows are backfilled below from the two
-- ledgers that already carry both sale_id and customer_id.
ALTER TABLE "sales" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_org_customer_idx" ON "sales" USING btree ("organization_id","customer_id");--> statement-breakpoint
-- Backfill from creditos (fiado sales that carried a real customer_id).
UPDATE "sales" SET "customer_id" = "c"."customer_id"
FROM "creditos" "c"
WHERE "c"."sale_id" = "sales"."id"
  AND "c"."customer_id" IS NOT NULL
  AND "sales"."customer_id" IS NULL;--> statement-breakpoint
-- Backfill from delivery_orders (settled domicilios linked to a customer).
UPDATE "sales" SET "customer_id" = "d"."customer_id"
FROM "delivery_orders" "d"
WHERE "d"."sale_id" = "sales"."id"
  AND "d"."customer_id" IS NOT NULL
  AND "sales"."customer_id" IS NULL;
