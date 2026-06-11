CREATE TABLE "platform_org_metadata" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"group_name" text,
	"notes" text,
	"known_issues" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
