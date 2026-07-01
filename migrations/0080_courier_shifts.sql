-- Courier shifts (delivery money core). A courier declares an EXISTING open
-- caja at the start of their shift; every order they mark 'delivered' during
-- the shift becomes a cash (Contraentrega -> efectivo) POS sale booked into
-- that caja. The partial UNIQUE index guarantees a courier has at most ONE
-- active shift (ended_at IS NULL) at a time.
CREATE TABLE "courier_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"courier_id" uuid NOT NULL,
	"pos_token_id" uuid,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "courier_shifts" ADD CONSTRAINT "courier_shifts_courier_id_pos_users_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."pos_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_shifts" ADD CONSTRAINT "courier_shifts_pos_token_id_pos_tokens_id_fk" FOREIGN KEY ("pos_token_id") REFERENCES "public"."pos_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_shifts_one_active_per_courier_idx" ON "courier_shifts" USING btree ("organization_id","courier_id") WHERE "courier_shifts"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "courier_shifts_org_courier_idx" ON "courier_shifts" USING btree ("organization_id","courier_id");
