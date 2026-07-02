-- Unify per-agent AI credit buckets into a single shared pool per org. Every
-- AI/e-invoicing action now draws 1 credit from the same org-wide pool instead
-- of three separate (org, agent_kind) buckets.
--
-- The collapse runs as ONE data-modifying-CTE statement: `rollup` sums the
-- existing buckets on the pre-delete snapshot, `cleared` removes the old rows
-- (data-modifying CTEs always run to completion), and the INSERT writes one
-- 'pool' row per org from `rollup`. No cross-statement temp state is needed,
-- and the new 'pool' agent_kind never collides with the old per-agent rows on
-- the still-present (org, agent_kind) unique index.
WITH rollup AS (
  SELECT
    organization_id,
    SUM(used) AS used,
    SUM(monthly_limit) AS monthly_limit,
    SUM(topped_up) AS topped_up
  FROM usage_counters
  GROUP BY organization_id
), cleared AS (
  DELETE FROM usage_counters
)
INSERT INTO usage_counters (organization_id, agent_kind, used, monthly_limit, topped_up)
SELECT organization_id, 'pool', used, monthly_limit, topped_up FROM rollup;--> statement-breakpoint
DROP INDEX IF EXISTS "usage_counters_org_agent_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_org_unique_idx" ON "usage_counters" ("organization_id");--> statement-breakpoint
ALTER TABLE "top_ups" ALTER COLUMN "agent_kind" DROP NOT NULL;
