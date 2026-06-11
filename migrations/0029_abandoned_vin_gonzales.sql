CREATE TABLE "staff_absences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'open' NOT NULL,
	"covered_by" uuid,
	"notified_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_absences" ADD CONSTRAINT "staff_absences_employee_id_pos_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."pos_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_absences" ADD CONSTRAINT "staff_absences_covered_by_pos_users_id_fk" FOREIGN KEY ("covered_by") REFERENCES "public"."pos_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_absences_org_date_idx" ON "staff_absences" USING btree ("organization_id","date");