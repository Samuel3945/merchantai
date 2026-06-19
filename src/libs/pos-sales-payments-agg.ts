import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

// Each sale's payment split as a JSON array, built with a CORRELATED SUBQUERY
// rather than a join. The POS sales list already json_aggs sale_items via a
// leftJoin+groupBy; adding a second join for payments would cartesian-product
// the two aggregations (items × payments). A correlated subquery keeps them
// independent. The cashier app reads this split to correct a mis-entered
// "error de carga" on a current-shift sale.
//
// Identifiers are written RAW (not via Drizzle column interpolation) on purpose:
// a column object interpolated in a sql`` fragment renders UNqualified (e.g.
// "id"), so `WHERE sp.sale_id = ${salesSchema.id}` would bind "id" to the inner
// sale_payments scope, not the outer sales row, and the correlation would never
// match. The fragment therefore assumes the outer query's FROM is the unaliased
// `sales` table (true for the POS sales list).
export function salePaymentsAggJson(): SQL<unknown> {
  return sql<unknown>`COALESCE(
    (
      SELECT json_agg(
        json_build_object('id', sp.id, 'method', sp.method, 'amount', sp.amount)
      )
      FROM sale_payments sp
      WHERE sp.sale_id = sales.id
    ),
    '[]'
  )`;
}
