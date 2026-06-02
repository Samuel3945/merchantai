// Read-only diagnostic probe. Confirms how created_at is stored vs. how the
// dashboard interprets it, plus product cost distribution. No writes.
// Usage: DATABASE_URL="<prod-url>" node scripts/db-probe.mjs
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to the database you want to inspect.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = async text => (await client.query(text)).rows;

console.log('session_timezone:', (await q('SHOW timezone'))[0]);

console.log(
  'created_at_interpretation:',
  (
    await q(`
      SELECT
        now()::text                                                       AS db_now,
        created_at::text                                                  AS raw_stored,
        (created_at AT TIME ZONE 'America/Bogota')::date::text            AS single_attz_date,
        (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date::text AS double_attz_date
      FROM sales
      ORDER BY created_at DESC
      LIMIT 3
    `)
  ),
);

console.log(
  'products_cost:',
  (
    await q(`
      SELECT
        count(*)::int                              AS total,
        count(*) FILTER (WHERE cost = 0)::int      AS cost_zero,
        count(*) FILTER (WHERE cost > 0)::int      AS cost_set,
        COALESCE(SUM(price * stock), 0)::float8    AS inv_value_at_price,
        COALESCE(SUM(cost * stock), 0)::float8     AS inv_value_at_cost
      FROM products
      WHERE deleted = false
    `)
  )[0],
);

console.log('sales_total:', (await q('SELECT count(*)::int AS n FROM sales'))[0]);

// Are the sale exit movements carrying a cost? If exit_cost_null > 0, the
// backfill has NOT been run for those sales and their COGS reads as 0
// (=> 100% margin) regardless of the deployed code.
console.log(
  'sale_exit_cost_coverage:',
  (
    await q(`
      SELECT
        count(*)::int                                  AS sale_exits,
        count(*) FILTER (WHERE unit_cost IS NULL)::int AS exit_cost_null,
        count(*) FILTER (WHERE unit_cost > 0)::int     AS exit_cost_set
      FROM stock_movements
      WHERE type = 'exit' AND reason = 'sale'
    `)
  )[0],
);

// Live margin for the last 30 days using the NEW formula (COGS from exit
// movements). This is exactly what the dashboard would show after a redeploy.
console.log(
  'margin_last_30d_new_formula:',
  (
    await q(`
      WITH ps AS (
        SELECT id, total::numeric AS total
        FROM sales
        WHERE status = 'completed'
          AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
              >= (now() AT TIME ZONE 'America/Bogota')::date - INTERVAL '30 days'
      ),
      costs AS (
        SELECT sm.sale_id, SUM(sm.qty * COALESCE(sm.unit_cost, 0)) AS cost
        FROM stock_movements sm
        WHERE sm.type = 'exit' AND sm.sale_id IN (SELECT id FROM ps)
        GROUP BY sm.sale_id
      )
      SELECT
        COALESCE(SUM(ps.total), 0)::float8                              AS revenue,
        COALESCE(SUM(COALESCE(c.cost, 0)), 0)::float8                   AS cogs,
        COALESCE(SUM(ps.total - COALESCE(c.cost, 0)), 0)::float8        AS profit,
        CASE WHEN SUM(ps.total) > 0
          THEN ROUND((SUM(ps.total - COALESCE(c.cost, 0)) / SUM(ps.total) * 100)::numeric, 1)
          ELSE 0 END                                                   AS margin_pct
      FROM ps LEFT JOIN costs c ON c.sale_id = ps.id
    `)
  )[0],
);

await client.end();
