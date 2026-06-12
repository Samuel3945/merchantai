ALTER TABLE "whatsapp_channels" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "whatsapp_channels" ADD COLUMN "capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL;