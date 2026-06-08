// Backfill the fiados ledger from the legacy "derived from sales" model.
// Before fiados became a first-class entity (see models/Schema.ts), a fiado was
// just a sale whose payment_type/method contained "fiado", with the customer
// parsed out of sales.notes. This seeds the new fiados + fiado_movements tables
// so the redesigned module, the timeline and the Historial tab have full data.
//
// Per legacy fiado sale it creates:
//   - one `fiados` row     (original_amount = sale.total, due_date = sale date +
//     the org's default term, status = paid if fully covered else pending),
//   - one `charge` movement (the "Venta fiada" timeline event, dated as the sale),
//   - one `payment` movement per non-fiado sale_payment (efectivo/nequi/...).
//
// IDEMPOTENT: a sale that already owns a fiado row is skipped, so this can be
// re-run after the Phase 1 write path goes live to catch any stragglers.
//
// Dry run (default): wraps everything in a transaction and ROLLS BACK.
//   DATABASE_URL="<db>" node scripts/db-backfill-fiados.mjs
// Apply:
//   DATABASE_URL="<db>" node scripts/db-backfill-fiados.mjs --apply
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to the database you want to backfill.');
  process.exit(1);
}
const apply = process.argv.includes('--apply');

const DEFAULT_TERM_DAYS = 30;
const TERM_SETTING_KEY = 'fiados-default-term-days';
const NAME_RE = /(?:Cliente|Nombre):\s*([^|]+)/i;
const PHONE_RE = /Tel:\s*([^|]+)/i;

function parseClient(notes) {
  if (!notes) {
    return { name: '', phone: '' };
  }
  return {
    name: notes.match(NAME_RE)?.[1]?.trim() ?? '',
    phone: notes.match(PHONE_RE)?.[1]?.trim() ?? '',
  };
}

// Digits-only normalization, mirroring how customers.whatsapp is stored, so a
// legacy fiado phone can be matched back to an existing customer row.
function normalizePhone(phone) {
  return (phone ?? '').replace(/\D/g, '');
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD for a `date` column
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('BEGIN');

let fiadosCreated = 0;
let chargeMovements = 0;
let paymentMovements = 0;
let customersLinked = 0;
let skipped = 0;

try {
  // Per-org default term (falls back to 30 days when unset).
  const { rows: termRows } = await client.query(
    `SELECT organization_id, value FROM app_settings WHERE key = $1`,
    [TERM_SETTING_KEY],
  );
  const termByOrg = new Map();
  for (const r of termRows) {
    const n = Number.parseInt(r.value, 10);
    if (Number.isFinite(n) && n > 0) {
      termByOrg.set(r.organization_id, n);
    }
  }

  // Every legacy fiado sale, oldest first.
  const { rows: sales } = await client.query(`
    SELECT s.id, s.organization_id, s.total::text AS total, s.notes,
           s.status, s.cashier_id, s.created_at
    FROM sales s
    WHERE s.status IN ('completed', 'settled')
      AND (
        s.payment_type ILIKE '%fiado%'
        OR EXISTS (
          SELECT 1 FROM sale_payments sp
          WHERE sp.sale_id = s.id AND sp.method ILIKE '%fiado%'
        )
      )
    ORDER BY s.created_at ASC
  `);

  for (const sale of sales) {
    // Idempotency: never create a second fiado for the same origin sale.
    const { rows: existing } = await client.query(
      `SELECT 1 FROM fiados WHERE sale_id = $1 LIMIT 1`,
      [sale.id],
    );
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    const total = Number.parseFloat(sale.total) || 0;
    if (total <= 0) {
      skipped++;
      continue;
    }

    const { name, phone } = parseClient(sale.notes);

    // Non-fiado payments already received against this sale = the abonos.
    const { rows: payments } = await client.query(
      `SELECT method, amount::text AS amount, created_at
       FROM sale_payments
       WHERE sale_id = $1 AND method NOT ILIKE '%fiado%'
       ORDER BY created_at ASC`,
      [sale.id],
    );
    const paidSum = payments.reduce(
      (a, p) => a + (Number.parseFloat(p.amount) || 0),
      0,
    );

    // Try to link an existing customer by normalized phone -> whatsapp.
    let customerId = null;
    const normPhone = normalizePhone(phone);
    if (normPhone) {
      const { rows: cust } = await client.query(
        `SELECT id FROM customers
         WHERE organization_id = $1 AND deleted = false
           AND regexp_replace(COALESCE(whatsapp, ''), '\\D', '', 'g') = $2
         LIMIT 1`,
        [sale.organization_id, normPhone],
      );
      customerId = cust[0]?.id ?? null;
      if (customerId) {
        customersLinked++;
      }
    }

    const termDays = termByOrg.get(sale.organization_id) ?? DEFAULT_TERM_DAYS;
    const dueDate = addDays(sale.created_at, termDays);
    const status
      = sale.status === 'settled' || paidSum >= total ? 'paid' : 'pending';
    const fiadoNotes = phone ? `${name} | Tel: ${phone}` : name || null;

    const { rows: inserted } = await client.query(
      `INSERT INTO fiados
         (organization_id, customer_id, sale_id, original_amount, due_date,
          status, notes, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING id`,
      [
        sale.organization_id,
        customerId,
        sale.id,
        total.toFixed(2),
        dueDate,
        status,
        fiadoNotes,
        sale.cashier_id,
        sale.created_at,
      ],
    );
    const fiadoId = inserted[0].id;
    fiadosCreated++;

    // The "Venta fiada +$total" timeline event, dated as the original sale.
    await client.query(
      `INSERT INTO fiado_movements
         (fiado_id, organization_id, type, amount, note, created_by, created_at)
       VALUES ($1, $2, 'charge', $3, 'Venta fiada', $4, $5)`,
      [
        fiadoId,
        sale.organization_id,
        total.toFixed(2),
        sale.cashier_id,
        sale.created_at,
      ],
    );
    chargeMovements++;

    for (const p of payments) {
      const amount = Number.parseFloat(p.amount) || 0;
      if (amount <= 0) {
        continue;
      }
      await client.query(
        `INSERT INTO fiado_movements
           (fiado_id, organization_id, type, amount, method, created_by,
            created_at)
         VALUES ($1, $2, 'payment', $3, $4, $5, $6)`,
        [
          fiadoId,
          sale.organization_id,
          amount.toFixed(2),
          p.method,
          sale.cashier_id,
          p.created_at,
        ],
      );
      paymentMovements++;
    }
  }

  console.log(`fiados created:        ${fiadosCreated}`);
  console.log(`charge movements:      ${chargeMovements}`);
  console.log(`payment movements:     ${paymentMovements}`);
  console.log(`customers linked:      ${customersLinked}`);
  console.log(`sales skipped:         ${skipped}`);

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
