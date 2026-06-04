CREATE TABLE "org_sale_counters" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "sale_number" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_org_number_unique_idx" ON "sales" USING btree ("organization_id","sale_number");--> statement-breakpoint
-- Backfill: assign sequential numbers to existing sales, per organization,
-- ordered by creation time (id breaks ties) so historical numbering is stable.
WITH ranked AS (
	SELECT id, ROW_NUMBER() OVER (
		PARTITION BY organization_id ORDER BY created_at, id
	) AS rn
	FROM sales
)
UPDATE sales SET sale_number = ranked.rn
FROM ranked
WHERE sales.id = ranked.id;--> statement-breakpoint
-- Seed each org's counter so new sales continue after the highest backfilled number.
INSERT INTO org_sale_counters (organization_id, last_number)
SELECT organization_id, MAX(sale_number)
FROM sales
WHERE sale_number IS NOT NULL
GROUP BY organization_id
ON CONFLICT (organization_id) DO UPDATE
	SET last_number = EXCLUDED.last_number;