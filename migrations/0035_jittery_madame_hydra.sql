CREATE TYPE "public"."whatsapp_channel_status" AS ENUM('connecting', 'connected', 'disconnected');--> statement-breakpoint
CREATE TABLE "whatsapp_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"instance_name" text NOT NULL,
	"label" text,
	"status" "whatsapp_channel_status" DEFAULT 'connecting' NOT NULL,
	"phone_number" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "whatsapp_channels_org_idx" ON "whatsapp_channels" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_channels_instance_unique_idx" ON "whatsapp_channels" USING btree ("instance_name");