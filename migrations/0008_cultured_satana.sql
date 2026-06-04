CREATE TABLE "cash_security_threshold_cache" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"threshold" numeric(14, 2) NOT NULL,
	"avg_daily_inflow" numeric(14, 2) NOT NULL,
	"accumulated_p85" numeric(14, 2) NOT NULL,
	"days_operated" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
