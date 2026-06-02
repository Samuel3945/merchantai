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

await client.end();
