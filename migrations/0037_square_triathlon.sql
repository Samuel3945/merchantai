ALTER TABLE "pos_return_items" ALTER COLUMN "qty" SET DATA TYPE numeric(12, 3);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "stock" SET DATA TYPE numeric(12, 3);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "min_stock" SET DATA TYPE numeric(12, 3);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "stock_max_recommended" SET DATA TYPE numeric(12, 3);--> statement-breakpoint
ALTER TABLE "sale_items" ALTER COLUMN "qty" SET DATA TYPE numeric(12, 3);--> statement-breakpoint
ALTER TABLE "stock_movements" ALTER COLUMN "qty" SET DATA TYPE numeric(12, 3);--> statement-breakpoint
ALTER TABLE "stock_movements" ALTER COLUMN "remaining_qty" SET DATA TYPE numeric(12, 3);