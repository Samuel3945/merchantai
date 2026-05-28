import type { Pool } from 'pg';
import { db } from './DB';

export const TABLE_CATALOG = `
Available tables (all scoped by organization_id — always filter with WHERE organization_id = :org_id):

1. products (id uuid PK, organization_id, name, barcode, price numeric, cost numeric, stock int, min_stock int, category text, unit_type enum(unit|kg), is_perishable bool, is_wholesale bool, status enum(draft|scheduled|published|archived), deleted bool, created_at, updated_at)

2. sales (id uuid PK, organization_id, total numeric, payment_type text, status enum(completed|settled|cancelled|returned), notes, cashier_id, pos_token_id, created_at)

3. sale_items (id uuid PK, sale_id FK→sales, product_id FK→products, product_name, qty int, price numeric, subtotal numeric, unit_type)

4. sale_payments (id uuid PK, sale_id FK→sales, method text, amount numeric, bills_paid jsonb, change_given numeric, reference, created_at)

5. customers (id uuid PK, organization_id, name, document_id, whatsapp, email, address, notes, total_spent numeric, last_purchase_at, deleted bool, created_at)

6. cash_sessions (id uuid PK, organization_id, opened_at, opened_by, opening_amount numeric, closed_at, closed_by, expected_amount, counted_amount, difference, status enum(open|closed))

7. cash_movements (id uuid PK, session_id FK→cash_sessions, organization_id, type enum(sale|deposit|expense|salary|inventory_purchase|withdrawal|adjustment), amount numeric, reason, created_by, sale_id, created_at)

8. stock_movements (id uuid PK, organization_id, product_id, product_name, type enum(entry|exit|adjustment), qty int, remaining_qty int, unit_cost numeric, expires_at date, reason, created_at)

9. pos_returns (id uuid PK, organization_id, sale_id FK→sales, reason enum, notes, total_refunded numeric, refund_method, partial bool, created_at)

10. pos_return_items (id uuid PK, return_id FK→pos_returns, sale_item_id, product_id, product_name, qty int, refund_amount numeric, restock bool)

Rules:
- ALWAYS use :org_id as the organization_id value. The system replaces it with the real org id.
- Only SELECT or WITH ... SELECT statements.
- Add LIMIT 200 if no explicit LIMIT.
- For monetary totals, use SUM/AVG on numeric columns.
- Dates are timestamptz; use date_trunc, generate_series, etc. for grouping.
- sales.status: 'completed' or 'settled' = valid sales. Exclude 'cancelled' and 'returned' unless asked.
`.trim();

const FORBIDDEN_KW = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|vacuum|call|merge|copy|do\s+\$|set\s+(?!timezone|datestyle)|reset|lock)\b/i;

export function validateAndBind(raw: string, orgId: string): { text: string; params: string[] } {
  const cleaned = raw
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
    .replace(/;+\s*$/, '');

  if (/;/.test(cleaned)) {
    throw new Error('Multiple statements not allowed');
  }
  if (!/^(select|with)\b/i.test(cleaned)) {
    throw new Error('Only SELECT/WITH queries allowed');
  }
  if (FORBIDDEN_KW.test(cleaned)) {
    throw new Error('Forbidden keyword detected');
  }
  if (!cleaned.includes(':org_id')) {
    throw new Error('Query must include :org_id filter');
  }

  const withLimit = /\blimit\s+\d+/i.test(cleaned) ? cleaned : `${cleaned} LIMIT 200`;

  let paramIndex = 0;
  const text = withLimit.replace(/:org_id/g, () => {
    paramIndex += 1;
    return `$${paramIndex}`;
  });
  const params = Array.from({ length: paramIndex }).fill(orgId);

  return { text, params };
}

export async function runReadOnlyQuery(orgId: string, rawSql: string) {
  const { text, params } = validateAndBind(rawSql, orgId);

  const pool = (db as any).$client as Pool;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = \'8000\'');
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return (res.rows as Record<string, unknown>[]).slice(0, 200);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
