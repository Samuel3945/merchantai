ALTER TABLE "employee_invitations" ADD COLUMN "panel_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_users" ADD COLUMN "clerk_user_id" text;--> statement-breakpoint
ALTER TABLE "pos_users" ADD COLUMN "panel_access" boolean DEFAULT false NOT NULL;