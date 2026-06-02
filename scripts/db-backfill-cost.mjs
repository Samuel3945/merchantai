// FIFO replay backfill. Repairs historical data so margin, COGS and the
// per-batch ledger are correct for sales made before FIFO consumption existed:
//   - sets unit_cost on each 'exit' movement to the weighted cost of the
//     batches it consumed (oldest first),
//   - rebuilds remaining_qty on every 'entry' batch (sales never drew them down),
//   - seeds products.cost (weighted average of entries) where it is still 0.
//
// Dry run (default): runs everything in a transaction and ROLLS BACK, printing
// what it would change.  DATABASE_URL="<prod>" node scripts/db-backfill-cost.mjs
// Apply: DATABASE_URL="<prod>" node scripts/db-backfill-cost.mjs --apply
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to the database you want to repair.');
  process.exit(1);
}
const apply = process.argv.includes('--apply');

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('BEGIN');

let exitsCosted = 0;
let batchesFixed = 0;
let productsCostSeeded = 0;

try {
  const { rows: products } = await client.query(`
    SELECT DISTINCT product_id, organization_id FROM stock_movements
  `);

  for (const { product_id, organization_id } of products) {
    const { rows: entries } = await client.query(
      `SELECT id, qty, COALESCE(unit_cost, 0)::float8 AS unit_cost
       FROM stock_movements
       WHERE product_id = $1 AND type = 'entry'
       ORDER BY created_at ASC`,
      [product_id],
    );
    const { rows: exits } = await client.query(
      `SELECT id, qty FROM stock_movements
       WHERE product_id = $1 AND type = 'exit'
       ORDER BY created_at ASC`,
      [product_id],
    );

    // Weighted-average cost across all entry batches — fallback for exits the
    // ledger can't fully cover, and the seed value for products.cost.
    const totalEntryQty = entries.reduce((a, e) => a + Number(e.qty), 0);
    const totalEntryCost = entries.reduce(
      (a, e) => a + Number(e.qty) * Number(e.unit_cost),
      0,
    );
    const avgCost = totalEntryQty > 0 ? totalEntryCost / totalEntryQty : 0;

    // In-memory FIFO batches, replayed from full quantities.
    const batches = entries.map(e => ({
      id: e.id,
      remaining: Number(e.qty),
      unit: Number(e.unit_cost),
    }));

    for (const exit of exits) {
      let remaining = Number(exit.qty);
      let totalCost = 0;
      for (const b of batches) {
        if (remaining <= 0) {
          break;
        }
        const take = Math.min(b.remaining, remaining);
        totalCost += take * b.unit;
        b.remaining -= take;
        remaining -= take;
      }
      if (remaining > 0) {
        totalCost += remaining * avgCost; // uncovered units at weighted average
      }
      const unitCost = Number(exit.qty) > 0 ? totalCost / Number(exit.qty) : 0;
      await client.query(
        `UPDATE stock_movements SET unit_cost = $1 WHERE id = $2`,
        [unitCost.toFixed(2), exit.id],
      );
      exitsCosted++;
    }

    for (const b of batches) {
      await client.query(
        `UPDATE stock_movements SET remaining_qty = $1 WHERE id = $2`,
        [b.remaining, b.id],
      );
      batchesFixed++;
    }

    if (avgCost > 0) {
      const { rowCount } = await client.query(
        `UPDATE products SET cost = $1
         WHERE id = $2 AND organization_id = $3 AND (cost IS NULL OR cost = 0)`,
        [avgCost.toFixed(2), product_id, organization_id],
      );
      productsCostSeeded += rowCount;
    }
  }

  console.log(`exits given a cost:        ${exitsCosted}`);
  console.log(`entry batches recomputed:  ${batchesFixed}`);
  console.log(`products.cost seeded:      ${productsCostSeeded}`);

  if (apply) {
    await client.query('COMMIT');
    console.log('\nAPPLIED — changes committed.');
  } else {
    await client.query('ROLLBACK');
    console.log('\nDRY RUN — rolled back. Re-run with --apply to commit.');
  }
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Failed, rolled back:', err);
  process.exitCode = 1;
} finally {
  await client.end();
}
