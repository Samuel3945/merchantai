// Backfills products.cost from each product's most recent stock-entry unit cost.
// Existing products were created before products.cost was seeded from the
// opening batch, so they sit at 0 and break margin/valuation. This repairs them.
//
// Dry run (default): reports how many rows WOULD change, writes nothing.
//   DATABASE_URL="<prod-url>" node scripts/db-backfill-cost.mjs
// Apply:
//   DATABASE_URL="<prod-url>" node scripts/db-backfill-cost.mjs --apply
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to the database you want to repair.');
  process.exit(1);
}
const apply = process.argv.includes('--apply');

const client = new pg.Client({ connectionString: url });
await client.connect();

// Latest entry unit cost per product, only where it would actually change cost.
const candidatesSql = `
  WITH latest_entry AS (
    SELECT DISTINCT ON (product_id) product_id, unit_cost
    FROM stock_movements
    WHERE type = 'entry' AND unit_cost IS NOT NULL AND unit_cost > 0
    ORDER BY product_id, created_at DESC
  )
  SELECT p.id, p.name, p.cost::float8 AS old_cost, le.unit_cost::float8 AS new_cost
  FROM products p
  JOIN latest_entry le ON le.product_id = p.id
  WHERE p.deleted = false
    AND (p.cost IS NULL OR p.cost = 0)
`;

const { rows: candidates } = await client.query(candidatesSql);
console.log(`products to repair: ${candidates.length}`);
for (const r of candidates.slice(0, 20)) {
  console.log(`  ${r.name}: ${r.old_cost} -> ${r.new_cost}`);
}
if (candidates.length > 20) {
  console.log(`  ...and ${candidates.length - 20} more`);
}

if (!apply) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.');
  await client.end();
  process.exit(0);
}

const { rowCount } = await client.query(`
  UPDATE products p
  SET cost = le.unit_cost
  FROM (
    SELECT DISTINCT ON (product_id) product_id, unit_cost
    FROM stock_movements
    WHERE type = 'entry' AND unit_cost IS NOT NULL AND unit_cost > 0
    ORDER BY product_id, created_at DESC
  ) le
  WHERE p.id = le.product_id
    AND p.deleted = false
    AND (p.cost IS NULL OR p.cost = 0)
`);
console.log(`\nAPPLIED — updated ${rowCount} products.`);
await client.end();
