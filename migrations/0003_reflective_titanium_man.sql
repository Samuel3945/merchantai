CREATE INDEX "products_org_idx" ON "products" USING btree ("organization_id","deleted");--> statement-breakpoint
CREATE INDEX "sale_items_sale_id_idx" ON "sale_items" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sale_items_product_id_idx" ON "sale_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sales_org_created_idx" ON "sales" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_org_status_created_idx" ON "sales" USING btree ("organization_id","status","created_at");