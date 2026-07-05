import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// This file defines the structure of your database tables using the Drizzle ORM.
//
// To modify the database schema:
// 1. Update this file with your desired changes.
// 2. Generate a new migration by running: `npm run db:generate`

export const todoSchema = pgTable('todo', {
  id: serial('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export const productUnitTypeEnum = pgEnum('product_unit_type', ['unit', 'kg']);

export const productStatusEnum = pgEnum('product_status', [
  'draft',
  'scheduled',
  'published',
  'archived',
]);

// How a category came to exist: 'manual' (owner typed/created it), 'ai' (an LLM
// suggestion was accepted) or 'auto' (created on the fly when a product was
// assigned a name not yet seen). Drives trust/ranking later.
export const categorySourceEnum = pgEnum('category_source', [
  'manual',
  'ai',
  'auto',
]);

// Per-org product categories. Categories are DYNAMIC: a row is created on demand
// the first time a product is assigned a name (see actions#upsertCategory) and
// ranked by usageCount. `attributeTemplate` is the learned set of characteristic
// keys typical for this category in THIS org (populated by a later slice) — the
// basis for "characterization that varies with the products that come in".
// `products.category` (text) is kept as a denormalized cache alongside the FK.
export const categoriesSchema = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    // Normalized key (lowercased, trimmed) so "Bebidas" and "bebidas" collapse
    // to one category per org.
    slug: text('slug').notNull(),
    source: categorySourceEnum('source').default('auto').notNull(),
    usageCount: integer('usage_count').default(0).notNull(),
    attributeTemplate: jsonb('attribute_template')
      .$type<{ key: string; count: number }[]>()
      .default([])
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    uniqueIndex('categories_org_slug_unique_idx').on(
      table.organizationId,
      table.slug,
    ),
    index('categories_org_usage_idx').on(
      table.organizationId,
      table.usageCount,
    ),
  ],
);

export const productsSchema = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    barcode: text('barcode'),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    cost: numeric('cost', { precision: 10, scale: 2 })
      .default('0')
      .notNull(),
    // Quantities are numeric (3 decimals) so products sold by weight/volume
    // (unit_type='kg') hold fractional stock. mode:'number' keeps the TS type a
    // plain number — the codebase treats stock/qty as numbers everywhere.
    stock: numeric('stock', { precision: 12, scale: 3, mode: 'number' })
      .default(0)
      .notNull(),
    minStock: numeric('min_stock', { precision: 12, scale: 3, mode: 'number' })
      .default(0)
      .notNull(),
    stockMaxRecommended: numeric('stock_max_recommended', {
      precision: 12,
      scale: 3,
      mode: 'number',
    }),
    // Denormalized category name (cache for cheap reads) + normalized FK. Both
    // are kept in sync by createProduct/updateProduct via upsertCategory.
    category: text('category'),
    categoryId: uuid('category_id').references(() => categoriesSchema.id, {
      onDelete: 'set null',
    }),
    unitType: productUnitTypeEnum('unit_type').default('unit').notNull(),
    isPerishable: boolean('is_perishable').default(false).notNull(),
    isWholesale: boolean('is_wholesale').default(false).notNull(),
    // Digital products (recharges, pins, licenses) sell without physical
    // inventory and never touch the FIFO ledger: stock stays 0 and availability
    // is governed by digitalLimit — NULL means unlimited, an integer is the
    // remaining sellable count (decremented by sales, restored by restocking
    // returns, editable by the admin).
    isDigital: boolean('is_digital').default(false).notNull(),
    digitalLimit: integer('digital_limit'),
    wholesaleTiers: jsonb('wholesale_tiers'),
    attributes: jsonb('attributes').default({}).notNull(),
    // Parsed presentation/size (e.g. "2L", "500g"), derived deterministically
    // from the product name by sizeFromName (src/features/products/search/size.ts)
    // — the single source of truth also used by search ranking. Nullable:
    // products with no recognizable size token (e.g. "Pan tajado") store null.
    // NOT the same as `attributes` above: that column is the merchant's
    // user-editable custom key/value fields, rendered as editable rows in the
    // product form — a computed object there would break that editor.
    size: jsonb('size').$type<{ value: number; unit: 'l' | 'ml' | 'kg' | 'g'; base: number; family: 'volume' | 'weight' }>(),
    status: productStatusEnum('status').default('published').notNull(),
    publishAt: timestamp('publish_at', { mode: 'date' }),
    deleted: boolean('deleted').default(false).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('products_org_barcode_unique_idx')
      .on(table.organizationId, table.barcode)
      .where(sql`${table.deleted} = false AND ${table.barcode} IS NOT NULL`),
    // The barcode unique index is partial, so the planner can't lean on it for
    // plain org listings/inventory. This covers product lists filtered by org.
    index('products_org_idx').on(table.organizationId, table.deleted),
  ],
);

// Per-org business-intelligence snapshot — PLATFORM-level analytics, never shown
// to the shop. Materialized (one row per org) and recomputed deterministically
// from products/sales/stock_movements/categories by libs/business-profile.ts (no
// LLM, same philosophy as smart-stock). Captures what kinds of businesses use the
// software, how big, and how they sell, for later analysis. All counts/sums are
// recomputed wholesale so the snapshot can't drift.
export const businessProfileSchema = pgTable('business_profile', {
  organizationId: text('organization_id').primaryKey(),
  // Catalog shape.
  productCount: integer('product_count').default(0).notNull(),
  activeProductCount: integer('active_product_count').default(0).notNull(),
  perishableCount: integer('perishable_count').default(0).notNull(),
  wholesaleCount: integer('wholesale_count').default(0).notNull(),
  distinctCategories: integer('distinct_categories').default(0).notNull(),
  totalStockUnits: integer('total_stock_units').default(0).notNull(),
  avgPrice: numeric('avg_price', { precision: 12, scale: 2 }),
  minPrice: numeric('min_price', { precision: 12, scale: 2 }),
  maxPrice: numeric('max_price', { precision: 12, scale: 2 }),
  // Commerce, rolling 30-day window.
  unitsSold30d: integer('units_sold_30d').default(0).notNull(),
  salesCount30d: integer('sales_count_30d').default(0).notNull(),
  distinctProductsSold30d: integer('distinct_products_sold_30d')
    .default(0)
    .notNull(),
  purchaseEvents30d: integer('purchase_events_30d').default(0).notNull(),
  // Derived.
  topCategories: jsonb('top_categories')
    .$type<{ name: string; usageCount: number }[]>()
    .default([])
    .notNull(),
  // Coarse v1 classification from objective ratios (refinable later from the
  // stored signals): 'grocery_fresh' | 'wholesale' | 'retail_general' | null.
  inferredBusinessType: text('inferred_business_type'),
  // AI-inferred rich business descriptor, e.g. "tienda de suplementos /
  // gimnasio". Unlike inferredBusinessType (deterministic, 3 coarse buckets),
  // this is an LLM label that powers context-aware product categorization. It is
  // recomputed ONLY when the deterministic context SIGNATURE below shifts (see
  // libs/ai-context.ts), so OpenAI is hit on real business shifts — not on every
  // daily refresh.
  aiBusinessContext: text('ai_business_context'),
  // Hash of the stable catalog signals the context was derived from. A new
  // signature ≠ stored one is what triggers a fresh inference (and a Layer-3
  // re-categorization pass). NULL until the first inference runs.
  aiContextSignature: text('ai_context_signature'),
  aiContextComputedAt: timestamp('ai_context_computed_at', { mode: 'date' }),
  computedAt: timestamp('computed_at', { mode: 'date' }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export const saleStatusEnum = pgEnum('sale_status', [
  'completed',
  'settled',
  'cancelled',
  'returned',
]);

// Where the sale originated, stored explicitly instead of inferred from
// posTokenId/notes. pos = register/device sale (web POS or pos-merchatai);
// panel = manual dashboard entry with no device; delivery = created from a
// delivered domicilio (see features/delivery/actions.ts#createDeliverySale);
// agent = a WhatsApp-bot order (see api/agent/orders/route.ts).
export const saleChannelEnum = pgEnum('sale_channel', [
  'pos',
  'panel',
  'delivery',
  'agent',
]);

export const salesSchema = pgTable(
  'sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // Human-readable, per-organization sequential number (e.g. shown as "#1001").
    // The UUID stays the internal/backend identifier; this is the commercial one.
    // Allocated atomically via org_sale_counters — see libs/sale-number.ts.
    saleNumber: integer('sale_number'),
    total: numeric('total', { precision: 10, scale: 2 }).notNull(),
    paymentType: text('payment_type').default('cash').notNull(),
    status: saleStatusEnum('status').default('completed').notNull(),
    notes: text('notes'),
    cashierId: text('cashier_id'),
    posTokenId: uuid('pos_token_id'),
    // Explicit sale origin — see saleChannelEnum above. Stamped at every
    // creation path (createSaleForOrg, the dashboard-manual wrapper, delivery
    // settlement, the agent order route, and the direct POS insert) so
    // delivery-vs-POS KPIs don't have to infer it from posTokenId/notes.
    channel: saleChannelEnum('channel').default('pos').notNull(),
    // Optional link to the customer the sale is attributed to (invoice-tagged
    // sale, fiado with a known client, or a settled delivery order). Nullable:
    // a plain anonymous POS sale keeps this NULL. SET NULL (not cascade) so
    // archiving a customer never deletes their sales — it just unlinks them.
    // Stamped inside the sale transaction at every path that knows the customer;
    // historical rows are backfilled from creditos/delivery_orders.
    // customersSchema is declared later in this file; the reference is a lazy
    // thunk (evaluated at runtime, after the module loads) so this is safe.
    // eslint-disable-next-line ts/no-use-before-define
    customerId: uuid('customer_id').references(() => customersSchema.id, {
      onDelete: 'set null',
    }),
    // DIAN e-invoicing intent + result, mirrored onto the sale for cheap reads.
    // Every sale starts 'pending' so it surfaces in the Facturas module; it
    // flips to 'emitted' (with cufe/number) or 'failed' once a provider runs.
    // The authoritative emission trail lives in `einvoice_emissions`.
    einvoiceStatus: text('einvoice_status').default('pending').notNull(),
    einvoiceCufe: text('einvoice_cufe'),
    einvoiceNumber: text('einvoice_number'),
    einvoiceId: uuid('einvoice_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    // Real BUSINESS time of the sale, as opposed to created_at (the server
    // insert time). For the always-online web POS they match; the field exists
    // so a future offline-capable client can ship the true sale time and have
    // analytics (e.g. caja saturation) measure on it instead of sync time.
    occurredAt: timestamp('occurred_at', { mode: 'date' }).defaultNow().notNull(),
    // Device-generated UUID v4 for exactly-once mobile sync. Nullable so the
    // web POS and pos-merchatai clients (which send no key) keep working — those
    // rows land with NULL. A partial UNIQUE index on (organization_id,
    // sale_idempotency_key) WHERE NOT NULL enforces one server row per device
    // key and is created CONCURRENTLY out of band (scripts/create-idempotency-index.sql)
    // to avoid locking the high-write sales table. The Drizzle schema declares
    // the index so dev/test environments pick it up via drizzle-kit push.
    saleIdempotencyKey: uuid('sale_idempotency_key'),
  },
  table => [
    // Sales listings and date-range reports scan by org + time window.
    index('sales_org_created_idx').on(table.organizationId, table.createdAt),
    // Dashboard metrics filter org + status before the date range.
    index('sales_org_status_created_idx').on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    // Caja saturation scans org + status over a trailing occurred_at window.
    index('sales_org_status_occurred_idx').on(
      table.organizationId,
      table.status,
      table.occurredAt,
    ),
    // One commercial number per organization; lets lookups by number be exact.
    uniqueIndex('sales_org_number_unique_idx').on(
      table.organizationId,
      table.saleNumber,
    ),
    // Customer detail (ficha de cliente) scans a customer's sales by org + FK.
    index('sales_org_customer_idx').on(
      table.organizationId,
      table.customerId,
    ),
    // Partial UNIQUE index for exactly-once mobile sync. NULL rows (web POS,
    // pos-merchatai) are excluded so many NULLs coexist without violating
    // uniqueness. In production this index is created CONCURRENTLY out of band
    // (scripts/create-idempotency-index.sql) — Drizzle's migrate() wraps files
    // in a transaction and Postgres forbids CONCURRENTLY inside a transaction.
    // Dev/test environments get the index via drizzle-kit push (non-concurrent).
    //
    // GUARDRAIL: migrations in this repo are hand-written and journal-registered.
    // Do NOT run `drizzle-kit generate`/`push` against the frozen baseline to
    // (re)create this index — generate would also try to emit the pre-existing
    // 0050→0062 snapshot drift. In prod this partial index ships ONLY via the
    // CONCURRENTLY runbook (scripts/README-idempotency-index.md). The declaration
    // here exists so the index is documented in schema and picked up by isolated
    // dev/test DBs, not so it is auto-generated into a migration.
    uniqueIndex('sales_org_idempotency_key_unique_idx')
      .on(table.organizationId, table.saleIdempotencyKey)
      .where(sql`${table.saleIdempotencyKey} IS NOT NULL`),
  ],
);

// Per-organization monotonic counter behind the human-readable sale number.
// A row is upserted-and-incremented inside the sale transaction so concurrent
// POS and dashboard sales can never be handed the same number.
export const orgSaleCountersSchema = pgTable('org_sale_counters', {
  organizationId: text('organization_id').primaryKey(),
  lastNumber: integer('last_number').default(0).notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const saleItemsSchema = pgTable(
  'sale_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => salesSchema.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => productsSchema.id, { onDelete: 'restrict' }),
    productName: text('product_name').notNull(),
    // Numeric (3 decimals) for weight/volume sales (e.g. 2.2 kg).
    qty: numeric('qty', { precision: 12, scale: 3, mode: 'number' }).notNull(),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    subtotal: numeric('subtotal', { precision: 10, scale: 2 }).notNull(),
    unitType: text('unit_type').default('unit').notNull(),
  },
  table => [
    // Postgres does NOT auto-index FK columns. Metrics JOIN sale_items by
    // sale_id (WHERE sale_id IN ...) and aggregate by product_id.
    index('sale_items_sale_id_idx').on(table.saleId),
    index('sale_items_product_id_idx').on(table.productId),
  ],
);

export const salePaymentsSchema = pgTable('sale_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  saleId: uuid('sale_id')
    .notNull()
    .references(() => salesSchema.id, { onDelete: 'cascade' }),
  method: text('method').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  billsPaid: jsonb('bills_paid'),
  changeGiven: numeric('change_given', { precision: 10, scale: 2 })
    .default('0')
    .notNull(),
  reference: text('reference'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export const salesRelations = relations(salesSchema, ({ many }) => ({
  items: many(saleItemsSchema),
  payments: many(salePaymentsSchema),
}));

export const saleItemsRelations = relations(saleItemsSchema, ({ one }) => ({
  sale: one(salesSchema, {
    fields: [saleItemsSchema.saleId],
    references: [salesSchema.id],
  }),
}));

export const salePaymentsRelations = relations(
  salePaymentsSchema,
  ({ one }) => ({
    sale: one(salesSchema, {
      fields: [salePaymentsSchema.saleId],
      references: [salesSchema.id],
    }),
  }),
);

export const cashSessionStatusEnum = pgEnum('cash_session_status', [
  'open',
  'closed',
]);

export const cashMovementTypeEnum = pgEnum('cash_movement_type', [
  'sale',
  'deposit',
  'expense',
  'salary',
  'inventory_purchase',
  'withdrawal',
  'adjustment',
  // Employee advance ("vale de empleado"): cash leaves the drawer but it is a
  // receivable against future salary, not a P&L expense. Behaves like withdrawal
  // for the cash math (a salida) and is excluded from operating expenses.
  'advance',
  // Cobro de credito: a customer pays down a credit account IN CASH. It is drawer
  // income for the arqueo, but it is NOT new revenue (the sale already booked
  // revenue when the credito was created) — so Finanzas excludes it. Only the
  // efectivo portion lands here; digital abonos (nequi/daviplata/transfer) are
  // recorded on the credito ledger but never touch the physical drawer.
  'credito_payment',
  // Payment reclassification: a sale's method split was mis-entered (e.g. a
  // mixed payment booked as all-cash). Moving an amount in/out of cash shifts the
  // expected drawer balance, so this posts a SIGNED compensating row (negative
  // when cash leaves the drawer because it was really a transfer, positive the
  // other way). It is neither revenue nor a cost — Finanzas ignores it, and the
  // arqueo sums it as its own term. Never edits the original sale movement.
  'reclassification',
]);

export const cashSessionsSchema = pgTable(
  'cash_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // The POS device (caja) that owns this session. Each register operates its
    // own till; they no longer share a single org-wide session. NULL = a session
    // opened outside a device (owner dashboard / legacy data).
    posTokenId: uuid('pos_token_id'),
    openedAt: timestamp('opened_at', { mode: 'date' }).defaultNow().notNull(),
    openedBy: text('opened_by').notNull(),
    openingAmount: numeric('opening_amount', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    closedAt: timestamp('closed_at', { mode: 'date' }),
    closedBy: text('closed_by'),
    expectedAmount: numeric('expected_amount', { precision: 12, scale: 2 }),
    countedAmount: numeric('counted_amount', { precision: 12, scale: 2 }),
    difference: numeric('difference', { precision: 12, scale: 2 }),
    status: cashSessionStatusEnum('status').default('open').notNull(),
    notes: text('notes'),
    // Open-time carry-over fields (Phase 3 — arqueo carryover). All nullable so
    // historical rows and not-yet-shipped device sessions remain valid.
    openingExpected: numeric('opening_expected', { precision: 12, scale: 2 }),
    openingDifference: numeric('opening_difference', { precision: 12, scale: 2 }),
    openingExplanation: text('opening_explanation'),
    // Device-generated UUID v4 for offline-authoritative open/close. Lets the
    // server dedupe replays (idempotent open) and reconcile a concurrent open.
    // NULL for legacy/admin sessions (dashboard, web POS) that send no key.
    clientSessionId: uuid('client_session_id'),
    // Stable identity of who opened/closed this session (pos_users uuid for an
    // employee, Clerk `user_*` id for the dashboard owner, NULL for a device-only
    // turn with no operator). The display name is resolved LIVE from this id at
    // read time — never a frozen snapshot. The legacy opened_by/closed_by TEXT
    // columns above stay as the historical fallback for rows written before this
    // column existed; they must not be treated as identifiers (a caja name baked
    // into them changes on rename). See actions/cash.ts#getCajaDetail.
    openedByActorId: text('opened_by_actor_id'),
    closedByActorId: text('closed_by_actor_id'),
  },
  table => [
    // One open session per POS device (caja). Each register operates its own till.
    uniqueIndex('cash_sessions_one_open_per_token_idx')
      .on(table.organizationId, table.posTokenId)
      .where(sql`${table.status} = 'open' AND ${table.posTokenId} IS NOT NULL`),
    // One open admin/legacy session per org (sessions with no device token, e.g.
    // opened from the owner dashboard).
    uniqueIndex('cash_sessions_one_open_admin_idx')
      .on(table.organizationId)
      .where(sql`${table.status} = 'open' AND ${table.posTokenId} IS NULL`),
    // Idempotent device open/close: one session row per (org, client_session_id).
    // Partial so the many legacy/admin sessions with a NULL key stay valid.
    uniqueIndex('cash_sessions_org_client_session_idx')
      .on(table.organizationId, table.clientSessionId)
      .where(sql`${table.clientSessionId} IS NOT NULL`),
  ],
);

// ── Suppliers ────────────────────────────────────────────────────────────────
// Vendors the business buys goods/services from. Owned by Caja today (supplier
// payments) and intentionally generic so Compras, Inventario and Cuentas por
// Pagar can reuse it later. Archived (soft) instead of deleted, so a supplier
// with payment history can never be wiped and break the cash ledger.
export const supplierStatusEnum = pgEnum('supplier_status', [
  'active',
  'archived',
]);

export const suppliersSchema = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    company: text('company'),
    phone: text('phone'),
    email: text('email'),
    city: text('city'),
    address: text('address'),
    taxId: text('tax_id'),
    notes: text('notes'),
    status: supplierStatusEnum('status').default('active').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('suppliers_org_status_idx').on(table.organizationId, table.status),
    // NIT unique per org only when present — loading it stays optional.
    uniqueIndex('suppliers_org_tax_id_idx')
      .on(table.organizationId, table.taxId)
      .where(sql`${table.taxId} IS NOT NULL`),
  ],
);

// Which products a supplier provides (many-to-many). Lets the agent answer
// "who can restock this item?" by reverse-looking-up suppliers from a product.
export const supplierProductsSchema = pgTable(
  'supplier_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliersSchema.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => productsSchema.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // A product is linked to a given supplier at most once.
    uniqueIndex('supplier_products_pair_idx').on(
      table.supplierId,
      table.productId,
    ),
    // Reverse lookup: "which suppliers provide this product?" within an org.
    index('supplier_products_org_product_idx').on(
      table.organizationId,
      table.productId,
    ),
  ],
);

export const cashMovementsSchema = pgTable(
  'cash_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => cashSessionsSchema.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    type: cashMovementTypeEnum('type').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    reason: text('reason').notNull(),
    // Optional expense category for "pago de gasto" outflows (nomina, servicios,
    // arriendo, transporte, marketing, otros). Null for every other movement.
    category: text('category'),
    authorizedBy: text('authorized_by'),
    createdBy: text('created_by').notNull(),
    saleId: uuid('sale_id').references(() => salesSchema.id, {
      onDelete: 'set null',
    }),
    // Set only for supplier payments. Soft-archive keeps the row; set null is the
    // safety net if a supplier is ever hard-deleted, so the movement survives.
    supplierId: uuid('supplier_id').references(() => suppliersSchema.id, {
      onDelete: 'set null',
    }),
    // Set on a post-close correction: the already-CLOSED session this adjustment
    // explains (e.g. a shortfall the owner accounts for the next day). The closed
    // session's own numbers stay immutable — the correction is this new dated
    // movement that references it, so the cash-fraud analysis keeps the original
    // discrepancy AND sees how/when/by whom it was explained.
    correctsSessionId: uuid('corrects_session_id').references(
      () => cashSessionsSchema.id,
      { onDelete: 'set null' },
    ),
    // Slice 3 — Inflows model: origin discriminator for entrada movements.
    // 'internal': cash entered from another treasury container (cofre / banco).
    //             A companion treasury_movements salida row debits the source.
    // 'external': direct owner injection — no source container.
    // null: legacy entry (pre-slice-3 devices) — treated as a plain cash entrada.
    // Only meaningful for INCOME movement types; ignored for expense types.
    origin: text('origin'),
    // Slice 3 — links an internal-origin entrada to its companion treasury debit
    // row (treasury_movements.id). Set only when origin='internal'. Nullable so
    // existing rows and external/legacy entries are unaffected. The FK is enforced
    // via migration 0055 (not .references() here — treasuryMovementsSchema is
    // defined later in this file; forward reference would work but the migration
    // approach keeps the pattern consistent with the handoverMovementId approach).
    treasuryMovementId: uuid('treasury_movement_id'),
    // gasto-treasury-unification slice 1: links a POS expense movement to its
    // P&L anchor row in expenses. Set only when type='expense'. Nullable so all
    // pre-existing rows remain valid. FK enforced via migration 0058 (not
    // .references() here — expensesSchema is defined later in this file; mirrors
    // the treasury_movements.expense_id approach from migration 0048).
    expenseId: uuid('expense_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('cash_movements_org_supplier_idx')
      .on(table.organizationId, table.supplierId)
      .where(sql`${table.supplierId} IS NOT NULL`),
  ],
);

export const cashSessionsRelations = relations(
  cashSessionsSchema,
  ({ many }) => ({
    movements: many(cashMovementsSchema),
  }),
);

export const cashMovementsRelations = relations(
  cashMovementsSchema,
  ({ one }) => ({
    session: one(cashSessionsSchema, {
      fields: [cashMovementsSchema.sessionId],
      references: [cashSessionsSchema.id],
    }),
    sale: one(salesSchema, {
      fields: [cashMovementsSchema.saleId],
      references: [salesSchema.id],
    }),
    supplier: one(suppliersSchema, {
      fields: [cashMovementsSchema.supplierId],
      references: [suppliersSchema.id],
    }),
  }),
);

// Inter-container money transfers (treasury). The first use is the consignación
// Caja Fuerte → Banco, which makes the safe an EXACT live balance (retiros −
// consignaciones) instead of an accumulated approximation. Account keys match
// the treasury position keys ('caja_fuerte', 'banco:<method>', 'caja:<token>')
// so this stays light until a formal accounts table arrives in a later phase.
export const treasuryTransfersSchema = pgTable(
  'treasury_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    fromAccount: text('from_account').notNull(),
    toAccount: text('to_account').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    note: text('note'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('treasury_transfers_org_idx').on(table.organizationId),
  ],
);

// ── Treasury containers (Phase 2A) ────────────────────────────────────────
// First-class accounts + unified movements ledger. Balance per container:
//   opening_balance + SUM(amount WHERE to_account_id = id)
//                   − SUM(amount WHERE from_account_id = id)
// Hot sales path (recordCashMovement / sales.ts) is NEVER touched by Phase 2.
export const treasuryAccountTypeEnum = pgEnum('treasury_account_type', [
  'caja',
  'caja_fuerte',
  'banco',
  'transito',
]);

export const treasuryMovementTypeEnum = pgEnum('treasury_movement_type', [
  'transfer',
  'consignacion',
  'entrada',
  'salida',
  'gasto',
  'adjustment',
  'handover',
  'refund',
]);

export const transferReconciliationStatusEnum = pgEnum(
  'transfer_reconciliation_status',
  ['pending', 'confirmed', 'not_arrived', 'mismatch', 'resolved'],
);

export const transferResolutionTypeEnum = pgEnum('transfer_resolution_type', [
  // The customer still owes it — converted into a credito (credit) debt.
  'receivable',
  // Written off; Finanzas offsets the revenue that never materialized. It does
  // NOT post a cash_movement — the money never entered the drawer, so removing
  // cash here would wrongly understate the arqueo.
  'loss',
  // The cashier accepted an invalid transfer (e.g. a fake screenshot). The
  // shortfall is attributed to them and raises a fraud alert.
  'cashier_liability',
]);

export const suppliersRelations = relations(suppliersSchema, ({ many }) => ({
  movements: many(cashMovementsSchema),
  products: many(supplierProductsSchema),
}));

export const supplierProductsRelations = relations(
  supplierProductsSchema,
  ({ one }) => ({
    supplier: one(suppliersSchema, {
      fields: [supplierProductsSchema.supplierId],
      references: [suppliersSchema.id],
    }),
    product: one(productsSchema, {
      fields: [supplierProductsSchema.productId],
      references: [productsSchema.id],
    }),
  }),
);

// ── Cash security threshold cache ──────────────────────────────────────────
// One row per organization, UPSERTed by the daily cron (reuses the smart-stock
// recompute job). Lets Caja paint the risk level without recomputing the
// behavioural threshold on every page load. payload carries the explainable
// breakdown (signals + policy snapshot + reasoning).
export const cashSecurityThresholdCacheSchema = pgTable(
  'cash_security_threshold_cache',
  {
    organizationId: text('organization_id').primaryKey(),
    threshold: numeric('threshold', { precision: 14, scale: 2 }).notNull(),
    avgDailyInflow: numeric('avg_daily_inflow', {
      precision: 14,
      scale: 2,
    }).notNull(),
    accumulatedP85: numeric('accumulated_p85', {
      precision: 14,
      scale: 2,
    }).notNull(),
    daysOperated: integer('days_operated').notNull(),
    payload: jsonb('payload').notNull(),
    computedAt: timestamp('computed_at', { mode: 'date' })
      .defaultNow()
      .notNull(),
  },
);

export const posUserRoleEnum = pgEnum('pos_user_role', [
  'admin',
  'cashier',
  'employee',
]);

// Cashier / employee accounts authenticated outside Clerk.
// Clerk handles org admins; this table holds the in-app POS users that log in
// with email + bcrypt password and consume short-lived session tokens.
export const posUsersSchema = pgTable(
  'pos_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    pin: text('pin').default('').notNull(),
    role: posUserRoleEnum('role').notNull(),
    active: boolean('active').default(true).notNull(),
    permissions: jsonb('permissions').default({}).notNull(),
    enabledModules: text('enabled_modules')
      .array()
      .default(sql`ARRAY['pos']::text[]`)
      .notNull(),
    canConfirmTransfers: boolean('can_confirm_transfers')
      .default(true)
      .notNull(),
    // Web panel access. The employee is ONE business user; Clerk is only the web
    // identity provider. `clerkUserId` links this single user to their Clerk
    // account (null when POS-only). `panelAccess` is INDEPENDENT from module
    // grants: it only decides whether the user can sign into the web panel at
    // all — which views they see once inside is governed by `enabledModules`.
    clerkUserId: text('clerk_user_id'),
    panelAccess: boolean('panel_access').default(false).notNull(),
    // Incremented on each successful password login. Same single-active-device
    // mechanism as pos_tokens.session_epoch: if the client's known epoch is lower
    // than the stored one, the session is considered revoked.
    sessionEpoch: integer('session_epoch').default(0).notNull(),
    // Monthly gross salary in local currency (informational, for payroll views).
    salary: numeric('salary', { precision: 12, scale: 2 }),
    // Contact phone — also consumed by the coverage/delivery agent.
    phone: text('phone'),
    // Partial weekly work schedule. Keys are weekday codes (mon|tue|wed|thu|fri|sat|sun).
    // Each entry: { start: "HH:MM", end: "HH:MM", off: boolean }
    // `off: true` means rest day; start/end are ignored when off is true.
    // Omitted keys inherit a default schedule defined at the org level.
    workSchedule: jsonb('work_schedule').default({}).notNull(),
    // Per-person PIN activation (Option B — see migration 0087). The admin never
    // sets the PIN; they send a WhatsApp activation link and the employee sets
    // their OWN PIN via /api/pos/cashiers/activate. `activationToken` stores a
    // SHA-256 HASH of the raw one-time token (never the raw token, which lives
    // only inside the link) so a DB leak can't be replayed; `activationExpiresAt`
    // bounds the link to 72h. Cleared on successful activation (single-use).
    activationToken: text('activation_token'),
    activationExpiresAt: timestamp('activation_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    // Wrong-PIN lockout on the shared-caja profile gate (verify-pin). After 5
    // consecutive wrong tries the account locks for 5 minutes; a correct PIN or a
    // fresh activation resets both.
    pinFailedAttempts: integer('pin_failed_attempts').default(0).notNull(),
    pinLockedUntil: timestamp('pin_locked_until', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [uniqueIndex('pos_users_email_unique_idx').on(table.email)],
);

export const posSessionsSchema = pgTable('pos_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => posUsersSchema.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export const posUsersRelations = relations(posUsersSchema, ({ many }) => ({
  sessions: many(posSessionsSchema),
}));

export const posSessionsRelations = relations(posSessionsSchema, ({ one }) => ({
  user: one(posUsersSchema, {
    fields: [posSessionsSchema.userId],
    references: [posUsersSchema.id],
  }),
}));

// Device tokens used by POS terminals to authenticate sync requests.
// Each token is a UUID printed/generated as QR and bound to a device + optional cashier.
// Reusable branch addresses per org. Multi-branch ("multisucursal") is modeled
// PER CAJA: each posToken points at one of these. The selector in Cajas POS lets
// the admin pick an existing address or create a new one, and edit them. The
// global business_address setting is retired in favor of these.
export const orgAddressesSchema = pgTable(
  'org_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // Optional branch label (e.g. "Centro", "Norte") to tell branches apart.
    name: text('name'),
    address: text('address').notNull(),
    city: text('city'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [index('org_addresses_org_idx').on(table.organizationId)],
);

export const whatsappChannelStatusEnum = pgEnum('whatsapp_channel_status', [
  'connecting',
  'connected',
  'disconnected',
]);

// A WhatsApp channel = one Evolution API instance owned by an organization.
// An org can have several channels (each is its own connected number).
export const whatsappChannelsSchema = pgTable(
  'whatsapp_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // Evolution instance name. Encodes the orgId so n8n maps an inbound message
    // to its org from the payload's `instance` field alone, with no callback:
    // `org_<clerkOrgId>__<short>` (see libs/evolution.ts buildInstanceName).
    instanceName: text('instance_name').notNull(),
    // Friendly name the admin gives the channel (e.g. "Ventas", "Soporte").
    label: text('label'),
    // What this channel is for, in the admin's words (e.g. "Atención clientes").
    purpose: text('purpose'),
    // What the agent is allowed to do on this channel: { [capabilityKey]: bool }.
    // Enforcement lives in the agent/n8n; the app owns the per-channel config.
    capabilities: jsonb('capabilities')
      .$type<Record<string, boolean>>()
      .default({})
      .notNull(),
    status: whatsappChannelStatusEnum('status').default('connecting').notNull(),
    // The connected number (E.164 digits), filled once the QR is scanned.
    phoneNumber: text('phone_number'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('whatsapp_channels_org_idx').on(table.organizationId),
    uniqueIndex('whatsapp_channels_instance_unique_idx').on(table.instanceName),
  ],
);

// Modo de caja (cajón): 'shared' = compartida (varias manos, responsabilidad
// colectiva, se puede compartir con otras cajas y domiciliarios); 'divided' =
// dividida (un solo responsable → un culpable claro si descuadra). Ver
// docs/caja-domiciliario/ESPECIFICACION.md §7.
export const posCashModeEnum = pgEnum('pos_cash_mode', ['shared', 'divided']);

export const posTokensSchema = pgTable(
  'pos_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    token: uuid('token').notNull().defaultRandom(),
    storeId: text('store_id').default('main').notNull(),
    deviceName: text('device_name').notNull(),
    // Branch address for this caja. Null => pos/connect falls back to the legacy
    // business_address setting during migration.
    addressId: uuid('address_id').references(() => orgAddressesSchema.id, {
      onDelete: 'set null',
    }),
    createdBy: text('created_by').notNull(),
    cashierId: uuid('cashier_id').references(() => posUsersSchema.id, {
      onDelete: 'set null',
    }),
    // Who is currently operating this caja. Stamped on profile change
    // (/api/pos/cashiers/verify-pin) for BOTH PIN and no-PIN employees, so the
    // admin sees the live operator. Distinct from cashierId (auth default).
    currentCashierId: uuid('current_cashier_id').references(
      () => posUsersSchema.id,
      { onDelete: 'set null' },
    ),
    currentCashierAt: timestamp('current_cashier_at', { mode: 'date' }),
    // active=false => caja bloqueada (no puede loguear ni sincronizar, pero la
    // fila persiste y libera cupo del plan). El borrado real elimina la fila.
    active: boolean('active').default(true).notNull(),
    // Per-cajero "sell without stock control". When true, the POS sale/sync
    // routes let a sale through even if stock is 0 (stock clamps at 0, FIFO
    // values uncovered units at fallback cost). Default false => stock enforced.
    allowOversell: boolean('allow_oversell').default(false).notNull(),
    // Modo del cajón: compartida (varias manos) vs dividida (un responsable).
    // Default 'divided' => cada caja es independiente salvo que el dueño la marque
    // compartida en el panel (dashboard/pos-cajeros). Ver ESPECIFICACION §7.
    cashMode: posCashModeEnum('cash_mode').default('divided').notNull(),
    // PIN de acceso de la caja (bcrypt). Se exige en /api/pos/login junto con el
    // token. '' => caja sin PIN (acceso directo con solo el token/QR).
    pin: text('pin').default('').notNull(),
    // Se incrementa cuando el admin "cierra la sesión" de la caja. El cajero
    // compara el epoch que conoce contra este; si difiere, bloquea al empleado
    // activo (vuelve al selector/PIN) sin perder el token de dispositivo.
    sessionEpoch: integer('session_epoch').default(0).notNull(),
    lastSyncAt: timestamp('last_sync_at', { mode: 'date' }),
    expiresAt: timestamp('expires_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    // treasury-sweep-model slice 2: per-caja auto-route destination.
    // When set, a shortfall at open auto-routes to this cofre (caja_fuerte)
    // instead of landing in Pendiente de ubicar. FK (ON DELETE SET NULL) is
    // enforced by migration 0054 — not referenced here to avoid the circular
    // initializer TypeScript error (treasuryAccountsSchema.posTokenId already
    // references posTokensSchema creating a mutual dependency).
    //
    // WARNING: This column has NO .references() call by design (circular-dep
    // workaround). The FK constraint pos_tokens_sweep_dest_fk is defined ONLY
    // in migration 0054. Running `drizzle-kit generate` or `drizzle-kit push`
    // from this schema would detect a "missing" FK and DROP that constraint in
    // production. Do NOT regenerate migrations from this column definition.
    defaultSweepDestinationAccountId: uuid(
      'default_sweep_destination_account_id',
    ),
  },
  table => [uniqueIndex('pos_tokens_token_unique_idx').on(table.token)],
);

export const posTokensRelations = relations(posTokensSchema, ({ one }) => ({
  cashier: one(posUsersSchema, {
    fields: [posTokensSchema.cashierId],
    references: [posUsersSchema.id],
  }),
}));

export const employeeInvitationStatusEnum = pgEnum(
  'employee_invitation_status',
  ['pending', 'accepted', 'revoked', 'expired'],
);

export const employeeInvitationsSchema = pgTable(
  'employee_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => posUsersSchema.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: posUserRoleEnum('role').notNull(),
    token: uuid('token').notNull().defaultRandom(),
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
    status: employeeInvitationStatusEnum('status').default('pending').notNull(),
    permissions: jsonb('permissions').default({}).notNull(),
    enabledModules: text('enabled_modules')
      .array()
      .default(sql`ARRAY['pos']::text[]`)
      .notNull(),
    canConfirmTransfers: boolean('can_confirm_transfers')
      .default(true)
      .notNull(),
    // Carried to the accept step so it knows whether to provision a Clerk web
    // identity for this single user.
    panelAccess: boolean('panel_access').default(false).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('employee_invitations_token_unique_idx').on(table.token),
  ],
);

export const employeeInvitationsRelations = relations(
  employeeInvitationsSchema,
  ({ one }) => ({
    user: one(posUsersSchema, {
      fields: [employeeInvitationsSchema.userId],
      references: [posUsersSchema.id],
    }),
  }),
);

// Operator-managed plan catalog. Single source of truth for what each plan
// costs and grants — replaces the hardcoded PLAN_* maps that used to live in
// actions/plans.ts, actions/pos-tokens.ts and actions/employees.ts. Plans are
// created/edited at runtime from the platform console; tenant code resolves an
// org's effective limits through libs/entitlements.ts, never by reading this
// table with a hardcoded slug.
export const plansSchema = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stable identifier stored in subscriptions.plan ('free', 'pro', ...).
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    priceMonthlyCop: numeric('price_monthly_cop', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    // Null means the plan has no annual option.
    priceAnnualCop: numeric('price_annual_cop', { precision: 12, scale: 2 }),
    // Marketing bullets rendered on the tenant plans page.
    featureBullets: jsonb('feature_bullets')
      .$type<string[]>()
      .default([])
      .notNull(),
    // Public plans appear on the tenant plans page; hidden ones are
    // operator-assigned only (custom deals, grandfathered tiers).
    isPublic: boolean('is_public').default(true).notNull(),
    // The plan an org falls back to when it has no active subscription.
    isDefault: boolean('is_default').default(false).notNull(),
    // Archived plans keep historical subscriptions resolvable but cannot be
    // selected for new upgrades.
    isArchived: boolean('is_archived').default(false).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    uniqueIndex('plans_slug_unique_idx').on(table.slug),
    uniqueIndex('plans_one_default_idx')
      .on(table.isDefault)
      .where(sql`${table.isDefault} = true`),
  ],
);

// What each plan grants. Numeric limits use the value directly
// (max_cashiers, ai_credits_sales_manager, ...); boolean features use 0/1
// (feature_smart_stock, ...). One row per (plan, key).
export const planEntitlementsSchema = pgTable(
  'plan_entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plansSchema.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: integer('value').default(0).notNull(),
  },
  table => [
    uniqueIndex('plan_entitlements_plan_key_unique_idx').on(
      table.planId,
      table.key,
    ),
  ],
);

// Operator-curated metadata about each business, maintained from the platform
// console: lifecycle status, free-form tags/groups for segmentation, internal
// notes and known issues. Never visible to the tenant.
export const platformOrgMetadataSchema = pgTable('platform_org_metadata', {
  organizationId: text('organization_id').primaryKey(),
  // Lifecycle bucket: none | trial | vip | at_risk | churned.
  status: text('status').default('none').notNull(),
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),
  groupName: text('group_name'),
  notes: text('notes'),
  knownIssues: text('known_issues'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

// Per-organization plan tier. Drives quota for cashiers, etc.
// DEPRECATED: never written by app code (upgrade flows only write
// `subscriptions`), which silently kept paying orgs on free-tier cashier
// limits. Readers now go through libs/entitlements.ts; this table stays only
// so existing rows remain queryable until it is dropped.
export const organizationPlanTierEnum = pgEnum('organization_plan_tier', [
  'free',
  'starter',
  'pro',
  'business',
]);

export const organizationPlansSchema = pgTable(
  'organization_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    plan: organizationPlanTierEnum('plan').default('free').notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('organization_plans_org_unique_idx').on(table.organizationId),
  ],
);

// Per-organization paid add-ons. addon='pos_cashier' grants +1 cashier slot.
export const planAddonsSchema = pgTable('plan_addons', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  addon: text('addon').notNull(),
  qty: integer('qty').default(1).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

// Active and historical subscriptions. Only one row per org should have
// active=true at any time; upgradePlan() flips the prior row to false and
// inserts a new active one.
export const subscriptionsSchema = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    plan: text('plan').notNull(),
    active: boolean('active').default(true).notNull(),
    periodStart: timestamp('period_start', { mode: 'date' })
      .defaultNow()
      .notNull(),
    periodEnd: timestamp('period_end', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('subscriptions_one_active_per_org_idx')
      .on(table.organizationId)
      .where(sql`${table.active} = true`),
  ],
);

// One row per org: a single shared AI-credit pool. monthly_limit comes from
// the plan; topped_up accumulates extra requests purchased; used is the
// consumption counter, reset on plan upgrade or billing-period rollover.
// `agentKind` is always the constant 'pool' — kept as a column (rather than
// dropped) so the table shape survives migration 0082_unify_credit_pool
// without a rename. See migrations/0082_unify_credit_pool.sql for the
// collapse of the old per-agent rows into this single-row-per-org shape.
export const usageCountersSchema = pgTable(
  'usage_counters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    agentKind: text('agent_kind').notNull(),
    used: integer('used').default(0).notNull(),
    monthlyLimit: integer('monthly_limit').default(0).notNull(),
    toppedUp: integer('topped_up').default(0).notNull(),
    resetAt: timestamp('reset_at', { mode: 'date' }),
  },
  table => [
    uniqueIndex('usage_counters_org_unique_idx').on(table.organizationId),
  ],
);

// Append-only log of top-up purchases. The granted requests are applied to
// usage_counters.topped_up only once Wompi confirms payment (webhook +
// authoritative query) — see actions/plans.ts#confirmTopUpPayment /
// applyApprovedTopUp. `reference` is the Wompi checkout reference
// ("topup-<uuid>"); its unique index is the idempotency key that guarantees a
// given payment can only ever grant credits once. `agentKind` is nullable and
// unused since the credit-pool unification (migration 0082) — kept only so
// historical rows still read; every row written from now on leaves it null.
export const topUpsSchema = pgTable(
  'top_ups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    agentKind: text('agent_kind'),
    amountCop: numeric('amount_cop', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    requestsAdded: integer('requests_added').default(0).notNull(),
    // 'pending' | 'approved' | 'declined' | 'voided' | 'error'
    status: text('status').default('pending').notNull(),
    reference: text('reference'),
    wompiTransactionId: text('wompi_transaction_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('top_ups_reference_unique_idx').on(table.reference),
  ],
);

export const customersSchema = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    documentId: text('document_id'),
    whatsapp: text('whatsapp'),
    email: text('email'),
    address: text('address'),
    notes: text('notes'),
    marketingOptIn: boolean('marketing_opt_in').default(true).notNull(),
    totalSpent: numeric('total_spent', { precision: 14, scale: 2 })
      .default('0')
      .notNull(),
    lastPurchaseAt: timestamp('last_purchase_at', { mode: 'date' }),
    createdBy: text('created_by'),
    deleted: boolean('deleted').default(false).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('customers_org_document_unique_idx')
      .on(table.organizationId, table.documentId)
      .where(
        sql`${table.documentId} IS NOT NULL AND ${table.deleted} = false`,
      ),
    uniqueIndex('customers_org_whatsapp_unique_idx')
      .on(table.organizationId, table.whatsapp)
      .where(
        sql`${table.whatsapp} IS NOT NULL AND ${table.deleted} = false`,
      ),
  ],
);

// ── Creditos (store-credit accounts) ─────────────────────────────────────────
// A credito is a first-class receivable: the customer took goods now and pays
// later. It replaces the old "derived from sales.notes" hack — see
// actions/creditos.ts. The account holds the headline figures (original amount,
// due date, status); credito_movements is the append-only ledger that records
// every charge, payment, plazo extension and adjustment chronologically. That
// ledger IS the timeline shown in the detail view and the full audit trail.
//
// Balance = original_amount − SUM(payment movements). A credito is `paid` when the
// balance reaches zero and `written_off` when forgiven. Rows are never deleted,
// so the Historial tab always has the complete record.
export const creditoStatusEnum = pgEnum('credito_status', [
  'pending',
  'paid',
  'written_off',
]);

export const creditoMovementTypeEnum = pgEnum('credito_movement_type', [
  // Origin of the debt — one per credito, amount = original_amount.
  'charge',
  // Customer pays down the balance (efectivo/nequi/daviplata/transferencia/otro).
  'payment',
  // Plazo extended — carries due_date_before / due_date_after for the audit.
  'extension',
  // Debt forgiven.
  'writeoff',
  // Manual correction (e.g. a return that reduces what is owed).
  'adjustment',
]);

export const creditosSchema = pgTable(
  'creditos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // Linked once the notes-regex identity is replaced by a real customer FK.
    // SET NULL (not cascade): archiving a customer must never wipe the debt.
    customerId: uuid('customer_id').references(() => customersSchema.id, {
      onDelete: 'set null',
    }),
    // Origin sale. SET NULL keeps the credito alive even if the sale is purged;
    // the unique index below makes the backfill idempotent (one credito per sale).
    saleId: uuid('sale_id').references(() => salesSchema.id, {
      onDelete: 'set null',
    }),
    originalAmount: numeric('original_amount', {
      precision: 12,
      scale: 2,
    }).notNull(),
    // The real payment deadline — the field the old model never stored. Used by
    // Vencido / Próximo a vencer / "Vence mañana" and the Caja-free risk states.
    dueDate: date('due_date').notNull(),
    status: creditoStatusEnum('status').default('pending').notNull(),
    // Display continuity during migration: holds the parsed "name | Tel: phone"
    // until customer_id is fully populated.
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    // Pendientes/Historial tabs and the dashboard counts filter org + status.
    index('creditos_org_status_idx').on(table.organizationId, table.status),
    // Vencidos / Próximos a vencer scan org + due_date.
    index('creditos_org_due_date_idx').on(table.organizationId, table.dueDate),
    index('creditos_customer_idx').on(table.customerId),
    // One credito per origin sale. Lets the backfill be re-run safely to catch
    // creditos created between Phase 0 and the Phase 1 write path going live.
    uniqueIndex('creditos_sale_unique_idx')
      .on(table.saleId)
      .where(sql`${table.saleId} IS NOT NULL`),
  ],
);

// Derived ledger for NON-cash incoming money (transferencia / nequi / daviplata,
// from both sales and credito abonos). It is the digital twin of cash_movements:
// cash lands in the drawer and is reconciled by the cashier (arqueo); transfers
// land in an account and are reconciled by whoever holds it (canConfirmTransfers),
// decoupled from the cash close. One row = one incoming transfer that must be
// confirmed against the bank/Nequi statement. A shared account resolves "which
// caja?" because every row carries pos_token_id / cash_session_id.
export const transferReconciliationsSchema = pgTable(
  'transfer_reconciliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // Sale source: the sale_payments row this transfer came from. UNIQUE so the
    // backfill and the offline POS sync can never double-insert. NULL for credito
    // abonos — those link the other way, via
    // credito_movements.transfer_reconciliation_id (mirror of cash_movement_id).
    salePaymentId: uuid('sale_payment_id').references(
      () => salePaymentsSchema.id,
      { onDelete: 'cascade' },
    ),
    // Attribution, denormalized so a shared bank account answers "which caja?"
    // without a join chain. NULL for admin/legacy/no-device money-in.
    posTokenId: uuid('pos_token_id').references(() => posTokensSchema.id, {
      onDelete: 'set null',
    }),
    cashSessionId: uuid('cash_session_id').references(
      () => cashSessionsSchema.id,
      { onDelete: 'set null' },
    ),
    // The free-text method label, mirroring sale_payments.method. The configured
    // account (payment_methods FK) is resolved in a later phase, not here.
    method: text('method').notNull(),
    // What the system says should arrive vs what actually landed (set on
    // confirm/mismatch). The shortfall is expected - arrived.
    expectedAmount: numeric('expected_amount', {
      precision: 12,
      scale: 2,
    }).notNull(),
    arrivedAmount: numeric('arrived_amount', { precision: 12, scale: 2 }),
    // Comprobante captured at money-in, used to match against the statement.
    reference: text('reference'),
    status: transferReconciliationStatusEnum('status')
      .default('pending')
      .notNull(),
    reconciledBy: text('reconciled_by'),
    reconciledAt: timestamp('reconciled_at', { mode: 'date' }),
    note: text('note'),
    // Resolution for a transfer that did NOT arrive (or arrived short).
    resolutionType: transferResolutionTypeEnum('resolution_type'),
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { mode: 'date' }),
    // Set when resolved as 'receivable': the credito (debt) booked for the customer.
    // Only legal when the sale has a known customer and the case was an honest
    // error — never for an anonymous sale or a fake comprobante.
    resolutionCreditoId: uuid('resolution_credito_id').references(
      () => creditosSchema.id,
      { onDelete: 'set null' },
    ),
    // PÉRDIDA+RECLAMO: true when a loss row has an active legal/insurance claim.
    // Only meaningful when resolution_type='loss'. Defaults to false for all rows.
    claimOpen: boolean('claim_open').default(false).notNull(),
    // Cross-period recovery: set on the NEW confirmed row that represents money
    // that reappeared after a closed-period loss. Points to the old loss row.
    // onDelete:'set null' preserves the recovery row even if old row is deleted.
    recoveryOfId: uuid('recovery_of_id').references(
      (): any => transferReconciliationsSchema.id,
      { onDelete: 'set null' },
    ),
    // Partial split: set on the ORIGINAL resolved row to link to the new
    // not_arrived remainder row created for the shortfall amount.
    remainderReconciliationId: uuid('remainder_reconciliation_id').references(
      (): any => transferReconciliationsSchema.id,
      { onDelete: 'set null' },
    ),
    // The cashier on duty's explanation of why they confirmed the comprobante,
    // recorded asynchronously while a not_arrived transfer is under investigation.
    // Feeds the cash-fraud analysis (who confirmed it, what they said, how late).
    cashierExplanation: text('cashier_explanation'),
    cashierExplainedBy: text('cashier_explained_by'),
    cashierExplainedAt: timestamp('cashier_explained_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // One reconciliation row per sale payment — makes the backfill and the
    // offline sync idempotent.
    uniqueIndex('transfer_reconciliations_sale_payment_idx')
      .on(table.salePaymentId)
      .where(sql`${table.salePaymentId} IS NOT NULL`),
    // The owner's reconciliation queue scans org + status.
    index('transfer_reconciliations_org_status_idx').on(
      table.organizationId,
      table.status,
    ),
    // Rollup + attribution by session/caja.
    index('transfer_reconciliations_session_idx').on(table.cashSessionId),
  ],
);

export const transferReconciliationsRelations = relations(
  transferReconciliationsSchema,
  ({ one }) => ({
    salePayment: one(salePaymentsSchema, {
      fields: [transferReconciliationsSchema.salePaymentId],
      references: [salePaymentsSchema.id],
    }),
    session: one(cashSessionsSchema, {
      fields: [transferReconciliationsSchema.cashSessionId],
      references: [cashSessionsSchema.id],
    }),
    resolutionCredito: one(creditosSchema, {
      fields: [transferReconciliationsSchema.resolutionCreditoId],
      references: [creditosSchema.id],
    }),
  }),
);

export const creditoMovementsSchema = pgTable(
  'credito_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creditoId: uuid('credito_id')
      .notNull()
      .references(() => creditosSchema.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    type: creditoMovementTypeEnum('type').notNull(),
    // Always positive; `type` decides the direction. Zero for pure extensions.
    amount: numeric('amount', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    // Set on payments only. Null for charge/extension.
    method: text('method'),
    // Links a cash (efectivo) payment to the Caja drawer movement it created.
    // Null for digital payments (nequi/daviplata/transferencia) — those are
    // collected but must NOT inflate the physical-cash arqueo. SET NULL so the
    // ledger survives if the cash movement is ever removed.
    cashMovementId: uuid('cash_movement_id').references(
      () => cashMovementsSchema.id,
      { onDelete: 'set null' },
    ),
    // Digital twin of cashMovementId: links a digital abono (nequi / daviplata /
    // transferencia) to the single reconciliation row it created, so the owner
    // confirms one incoming transfer even when it paid down several creditos.
    // Null for cash abonos (those use cashMovementId) and for charge/extension.
    transferReconciliationId: uuid('transfer_reconciliation_id').references(
      () => transferReconciliationsSchema.id,
      { onDelete: 'set null' },
    ),
    // Plazo-extension audit: the deadline before and after the change.
    dueDateBefore: date('due_date_before'),
    dueDateAfter: date('due_date_after'),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // The timeline: every movement of a credito, oldest first.
    index('credito_movements_credito_created_idx').on(
      table.creditoId,
      table.createdAt,
    ),
    // "Recuperado este mes" and the digital-vs-cash report split scan
    // org + type + time window.
    index('credito_movements_org_type_created_idx').on(
      table.organizationId,
      table.type,
      table.createdAt,
    ),
  ],
);

export const creditosRelations = relations(creditosSchema, ({ one, many }) => ({
  customer: one(customersSchema, {
    fields: [creditosSchema.customerId],
    references: [customersSchema.id],
  }),
  sale: one(salesSchema, {
    fields: [creditosSchema.saleId],
    references: [salesSchema.id],
  }),
  movements: many(creditoMovementsSchema),
}));

export const creditoMovementsRelations = relations(
  creditoMovementsSchema,
  ({ one }) => ({
    credito: one(creditosSchema, {
      fields: [creditoMovementsSchema.creditoId],
      references: [creditosSchema.id],
    }),
    cashMovement: one(cashMovementsSchema, {
      fields: [creditoMovementsSchema.cashMovementId],
      references: [cashMovementsSchema.id],
    }),
    transferReconciliation: one(transferReconciliationsSchema, {
      fields: [creditoMovementsSchema.transferReconciliationId],
      references: [transferReconciliationsSchema.id],
    }),
  }),
);

export const posReturnReasonEnum = pgEnum('pos_return_reason', [
  'wrong_product',
  'damaged',
  'customer_request',
  'price_error',
  'duplicate',
  'other',
  // Added with the reason-vs-destination split: why the customer returns.
  'business_error',
  'warranty',
]);

// Destination of returned goods — what physically happens to the merchandise,
// kept separate from the reason. Only 'restock' returns units to sellable stock.
export const posReturnDispositionEnum = pgEnum('pos_return_disposition', [
  'restock',
  'damaged',
  'warranty',
  'discard',
]);

export const posReturnsSchema = pgTable('pos_returns', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  saleId: uuid('sale_id')
    .notNull()
    .references(() => salesSchema.id, { onDelete: 'restrict' }),
  reason: posReturnReasonEnum('reason').notNull(),
  notes: text('notes'),
  totalRefunded: numeric('total_refunded', { precision: 12, scale: 2 })
    .default('0')
    .notNull(),
  refundMethod: text('refund_method').notNull(),
  partial: boolean('partial').default(false).notNull(),
  cashierId: uuid('cashier_id').references(() => posUsersSchema.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export const posReturnItemsSchema = pgTable('pos_return_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  returnId: uuid('return_id')
    .notNull()
    .references(() => posReturnsSchema.id, { onDelete: 'cascade' }),
  saleItemId: uuid('sale_item_id')
    .notNull()
    .references(() => saleItemsSchema.id, { onDelete: 'restrict' }),
  productId: uuid('product_id').notNull(),
  productName: text('product_name').notNull(),
  qty: numeric('qty', { precision: 12, scale: 3, mode: 'number' }).notNull(),
  refundAmount: numeric('refund_amount', { precision: 12, scale: 2 })
    .default('0')
    .notNull(),
  restock: boolean('restock').default(true).notNull(),
  // Where the returned goods went. Only 'restock' adds them back to sellable
  // stock; 'damaged' | 'discard' are audit-only and never touch inventory.
  // `restock` stays in sync (true iff disposition === 'restock').
  disposition: posReturnDispositionEnum('disposition')
    .default('restock')
    .notNull(),
});

export const posReturnsRelations = relations(
  posReturnsSchema,
  ({ one, many }) => ({
    sale: one(salesSchema, {
      fields: [posReturnsSchema.saleId],
      references: [salesSchema.id],
    }),
    items: many(posReturnItemsSchema),
  }),
);

export const posReturnItemsRelations = relations(
  posReturnItemsSchema,
  ({ one }) => ({
    return: one(posReturnsSchema, {
      fields: [posReturnItemsSchema.returnId],
      references: [posReturnsSchema.id],
    }),
    saleItem: one(saleItemsSchema, {
      fields: [posReturnItemsSchema.saleItemId],
      references: [saleItemsSchema.id],
    }),
  }),
);

// ── Smart Stock: stock_movements ledger ─────────────────────────────────────
// Append-only ledger of stock changes. type='entry' rows can carry expiresAt
// for perishable batches and feed the expiration-risk engine.
export const stockMovementTypeEnum = pgEnum('stock_movement_type', [
  'entry',
  'exit',
  'adjustment',
]);

export const stockMovementsSchema = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // FK with ON DELETE restrict — symmetric with sale_items. Makes the DB the
    // backstop for "you can't delete a product that has inventory history",
    // closing the orphan-movement race regardless of which path inserts a
    // movement. Safe to add: the codebase never hard-deleted products before, so
    // no orphan movements can exist.
    productId: uuid('product_id')
      .notNull()
      .references(() => productsSchema.id, { onDelete: 'restrict' }),
    productName: text('product_name'),
    type: stockMovementTypeEnum('type').notNull(),
    // Numeric (3 decimals) so the FIFO ledger tracks fractional weight/volume.
    qty: numeric('qty', { precision: 12, scale: 3, mode: 'number' }).notNull(),
    // For 'entry' rows: units of this batch still in stock (decremented by FIFO
    // on each exit). NULL means "not tracked per batch" (legacy or non-perishable).
    remainingQty: numeric('remaining_qty', {
      precision: 12,
      scale: 3,
      mode: 'number',
    }),
    unitCost: numeric('unit_cost', { precision: 12, scale: 2 }),
    // Only set when type='entry' and the product is perishable. The engine
    // sources daysToExpire from this column.
    expiresAt: date('expires_at'),
    reason: text('reason'),
    createdBy: text('created_by'),
    saleId: uuid('sale_id').references(() => salesSchema.id, {
      onDelete: 'set null',
    }),
    supplierId: text('supplier_id'),
    // Free-text detail. REQUIRED when reason='manual' ("Otro motivo") so every
    // off-book adjustment — initial inventory, count shortfall/surplus, returns
    // to supplier, in-shop consumption — carries an auditable explanation.
    notes: text('notes'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('stock_movements_org_product_idx').on(
      table.organizationId,
      table.productId,
    ),
    // Partial index: only batches with an expiration date hit the lookup.
    index('stock_movements_expires_at_idx')
      .on(table.organizationId, table.productId, table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL`),
  ],
);

// ── Smart Stock: expiration risk cache ─────────────────────────────────────
// One row per (organization, movement) UPSERTed by the daily cron. Lets the
// front-end paint tier badges without recomputing.
export const expirationRiskCacheSchema = pgTable(
  'expiration_risk_cache',
  {
    organizationId: text('organization_id').notNull(),
    movementId: uuid('movement_id').notNull(),
    productId: uuid('product_id').notNull(),
    // Shape: { tier, riskRatio, daysToExpire, daysToSell, remainingQty,
    //          avgDaily, unitCost, salePrice, suggestedPct, suggestedPrice,
    //          maxSafePct, reasoning, classificationSource }
    payload: jsonb('payload').notNull(),
    computedAt: timestamp('computed_at', { mode: 'date' }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  },
  table => [
    primaryKey({
      name: 'expiration_risk_cache_pk',
      columns: [table.organizationId, table.movementId],
    }),
    index('expiration_risk_cache_product_idx').on(
      table.organizationId,
      table.productId,
    ),
  ],
);

// ── Smart Stock: actionable discount suggestions ───────────────────────────
// "Gerenta IA" insists without nagging: a new suggestion only opens when the
// tier escalates or ≥3 days passed since rejection, capped at 3 reopens.
export const expirationTierEnum = pgEnum('expiration_tier', [
  'atencion',
  'urgente',
  'critico',
]);

export const expirationSuggestionStatusEnum = pgEnum(
  'expiration_suggestion_status',
  ['pending', 'accepted', 'rejected', 'superseded', 'expired'],
);

export const expirationSuggestionsSchema = pgTable(
  'expiration_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    movementId: uuid('movement_id').notNull(),
    productId: uuid('product_id').notNull(),
    tier: expirationTierEnum('tier').notNull(),
    suggestedPct: numeric('suggested_pct', { precision: 5, scale: 2 }).notNull(),
    maxSafePct: numeric('max_safe_pct', { precision: 5, scale: 2 }).notNull(),
    suggestedPrice: numeric('suggested_price', {
      precision: 12,
      scale: 2,
    }).notNull(),
    basePrice: numeric('base_price', { precision: 12, scale: 2 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 12, scale: 2 }).notNull(),
    reasoning: text('reasoning').notNull(),
    status: expirationSuggestionStatusEnum('status')
      .default('pending')
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { mode: 'date' }),
    resolvedBy: text('resolved_by'),
    reopenCount: integer('reopen_count').default(0).notNull(),
    notificationId: uuid('notification_id'),
    meta: jsonb('meta').default({}).notNull(),
  },
  table => [
    index('expiration_suggestions_movement_idx').on(
      table.organizationId,
      table.movementId,
      table.status,
    ),
    index('expiration_suggestions_pending_idx')
      .on(table.organizationId, table.status)
      .where(sql`${table.status} = 'pending'`),
    index('expiration_suggestions_product_idx').on(
      table.organizationId,
      table.productId,
      table.createdAt,
    ),
  ],
);

export const stockMovementsRelations = relations(
  stockMovementsSchema,
  ({ one }) => ({
    product: one(productsSchema, {
      fields: [stockMovementsSchema.productId],
      references: [productsSchema.id],
    }),
  }),
);

export const expirationSuggestionsRelations = relations(
  expirationSuggestionsSchema,
  ({ one }) => ({
    movement: one(stockMovementsSchema, {
      fields: [expirationSuggestionsSchema.movementId],
      references: [stockMovementsSchema.id],
    }),
    product: one(productsSchema, {
      fields: [expirationSuggestionsSchema.productId],
      references: [productsSchema.id],
    }),
  }),
);

export const paymentMethodTypeEnum = pgEnum('payment_method_type', [
  'cash',
  'transfer',
  'card',
  'credit',
  'other',
]);

// Per-organization catalog of payment methods used at checkout. Seeded with
// the Colombian defaults (Efectivo, Nequi, Daviplata, Llave, Tarjeta, Credito)
// when the org first asks for them. Soft-deleted via active=false so audit
// trails on past sales (paymentType/method) still resolve.
export const paymentMethodsSchema = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    type: paymentMethodTypeEnum('type').notNull(),
    icon: text('icon'),
    active: boolean('active').default(true).notNull(),
    startHour: integer('start_hour'),
    endHour: integer('end_hour'),
    sortOrder: integer('sort_order').default(0).notNull(),
    details: jsonb('details').default({}).notNull(),
    description: text('description'),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('payment_methods_org_sort_idx').on(
      table.organizationId,
      table.sortOrder,
    ),
  ],
);

// Treasury containers (perpetual-balance accounts: cajas, cajas fuertes,
// bancos). Defined after payment_methods + pos_tokens because its FKs reference
// them. Enums live near the cash tables above.
export const treasuryAccountsSchema = pgTable(
  'treasury_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    type: treasuryAccountTypeEnum('type').notNull(),
    name: text('name').notNull(),
    openingBalance: numeric('opening_balance', {
      precision: 12,
      scale: 2,
    })
      .default('0')
      .notNull(),
    active: boolean('active').default(true).notNull(),
    // banco only — FK to payment_methods; RESTRICT so deleting a method that
    // still backs an account is blocked at the DB level.
    paymentMethodId: uuid('payment_method_id').references(
      () => paymentMethodsSchema.id,
      { onDelete: 'restrict' },
    ),
    // caja link — SET NULL so retiring a POS device doesn't orphan the account.
    posTokenId: uuid('pos_token_id').references(() => posTokensSchema.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  t => [
    index('treasury_accounts_org_idx').on(t.organizationId, t.type),
    // Name is unique only among ACTIVE accounts, so deleting an account frees
    // its name for reuse (partial index — see migration 0072).
    uniqueIndex('treasury_accounts_org_name_unique')
      .on(t.organizationId, t.name)
      .where(sql`${t.active} = true`),
  ],
);

// ── Notifications ─────────────────────────────────────────────────────────
// Per-org notification feed (low stock, expiring batches, overdue creditos,
// cash-close discrepancies, generic sale alerts). Severity drives UI
// emphasis (e.g. red pulse on the bell for 'high').
export const notificationKindEnum = pgEnum('notification_kind', [
  'cash_difference',
  'low_stock',
  'expiring_soon',
  'credito_overdue',
  'sale_alert',
  // Operator broadcast from the platform console (announcements, maintenance,
  // incidents). Rendered with a generic icon and no deep link.
  'platform_announcement',
]);

export const notificationSeverityEnum = pgEnum('notification_severity', [
  'low',
  'mid',
  'high',
]);

export const notificationsSchema = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    kind: notificationKindEnum('kind').notNull(),
    severity: notificationSeverityEnum('severity').default('mid').notNull(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    read: boolean('read').default(false).notNull(),
    payload: jsonb('payload').default({}).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('notifications_org_created_idx').on(
      table.organizationId,
      table.createdAt,
    ),
    index('notifications_org_unread_idx')
      .on(table.organizationId, table.createdAt)
      .where(sql`${table.read} = false`),
  ],
);

// ── Audit log ─────────────────────────────────────────────────────────────
// Append-only trail of mutations performed across the platform. Written by
// the `logAction` helper after every important server-action / API mutation
// (sales, returns, customer/product changes, cash open/close, employee
// invitations, plan upgrades, etc.).
//
// `before` / `after` are JSON snapshots; either can be null (a creation has
// no before, a deletion has no after). `actorType` distinguishes whose hand
// produced the change — a Clerk admin (`user`), a POS cashier (`cashier`),
// a cron job (`system`), or an external API/webhook (`api`).
export const auditActorTypeEnum = pgEnum('audit_actor_type', [
  'user',
  'cashier',
  'system',
  'api',
]);

export const auditLogsSchema = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    metadata: jsonb('metadata').default({}).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('audit_logs_org_created_idx').on(
      table.organizationId,
      table.createdAt,
    ),
    index('audit_logs_org_action_idx').on(table.organizationId, table.action),
    index('audit_logs_org_entity_idx').on(
      table.organizationId,
      table.entityType,
      table.entityId,
    ),
    index('audit_logs_org_actor_idx').on(table.organizationId, table.actorId),
  ],
);

// Generic key/value store scoped per organization. Used by onboarding,
// feature flags, business profile, and any per-org preference that doesn't
// warrant its own table. Value is text — callers serialize JSON if needed.
export const appSettingsSchema = pgTable(
  'app_settings',
  {
    organizationId: text('organization_id').notNull(),
    key: text('key').notNull(),
    value: text('value').default('').notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    primaryKey({
      name: 'app_settings_pk',
      columns: [table.organizationId, table.key],
    }),
  ],
);

// ── DIAN e-invoicing emissions ──────────────────────────────────────────────
// Append-only audit trail of every attempt to emit an electronic document for a
// sale through a provider (MATIAS). One sale can have several rows: a
// failed attempt then a successful retry (kind 'invoice'), plus a 'credit_note'
// when the sale is later returned. The provider adapter writes the request
// `payload` and raw `response` here so a failed emission is fully debuggable.
// `sales.einvoice_*` mirrors the latest successful invoice for cheap listing.
export const einvoiceEmissionsSchema = pgTable(
  'einvoice_emissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => salesSchema.id, { onDelete: 'cascade' }),
    // 'invoice' | 'pos' | 'credit_note'
    kind: text('kind').default('invoice').notNull(),
    // 'matias'; the column lets a second adapter coexist later.
    provider: text('provider').default('matias').notNull(),
    // 'queued' | 'sent' | 'emitted' | 'failed'
    status: text('status').default('queued').notNull(),
    providerId: text('provider_id'),
    cufe: text('cufe'),
    number: text('number'),
    // MATIAS result artifacts (also kept raw in `response`).
    dianStatus: text('dian_status'),
    pdfUrl: text('pdf_url'),
    xmlUrl: text('xml_url'),
    // Credits charged for this document (1 per emitted document; 0 on retries).
    creditsConsumed: integer('credits_consumed').default(0).notNull(),
    customer: jsonb('customer'),
    payload: jsonb('payload'),
    response: jsonb('response'),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    emittedAt: timestamp('emitted_at', { mode: 'date' }),
  },
  table => [
    index('einvoice_emissions_org_sale_idx').on(
      table.organizationId,
      table.saleId,
    ),
    index('einvoice_emissions_sale_kind_created_idx').on(
      table.saleId,
      table.kind,
      table.createdAt,
    ),
  ],
);

// ── Domicilios (delivery orders) ────────────────────────────────────────────
// A delivery_order is what the courier ("domiciliario") sees and acts on: an
// order to carry to an address. The AI agent (WhatsApp intake) or the POS
// create it; the courier moves it through the status state machine and the
// customer is notified on each transition. `delivery_events` is the append-only
// ledger of everything that happened to the order (status changes, notes,
// outbound notifications) — it mirrors the credito_movements pattern and IS the
// "Historial" the courier view renders.
//
// State machine: pending → assigned → in_transit → delivered
//                (any non-terminal) → cancelled
// A cancellation (customer regrets the purchase) flips status to 'cancelled',
// which drops the order from the courier's active board and triggers a notify.
export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'assigned',
  'in_transit',
  'delivered',
  'cancelled',
]);

export const deliveryOrdersSchema = pgTable(
  'delivery_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // Linked customer (holds the WhatsApp number used for notifications). SET
    // NULL so archiving a customer never wipes the delivery history.
    customerId: uuid('customer_id').references(() => customersSchema.id, {
      onDelete: 'set null',
    }),
    // Set when a delivered order auto-generates a sale, or when it originated
    // from a POS sale. SET NULL keeps the delivery row if the sale is purged.
    saleId: uuid('sale_id').references(() => salesSchema.id, {
      onDelete: 'set null',
    }),
    // Assigned courier (a pos_user). SET NULL so removing an employee never
    // deletes the order; it just becomes unassigned.
    courierId: uuid('courier_id').references(() => posUsersSchema.id, {
      onDelete: 'set null',
    }),
    status: deliveryStatusEnum('status').default('pending').notNull(),
    // Denormalized snapshot so the courier view renders without extra joins and
    // survives even if the customer record later changes.
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    address: text('address').notNull(),
    addressNotes: text('address_notes'),
    // What to deliver: [{ name, qty, price, productId? }]. A snapshot (not FKs)
    // so the courier always sees what was agreed even if products change later.
    // productId is captured on agent/POS orders so a delivered order can be
    // turned into a real POS sale (stock + caja); legacy/manual free-text lines
    // may lack it and are then handled manually at delivery time.
    items: jsonb('items')
      .$type<{ name: string; qty: number; price: number; productId?: string }[]>()
      .default([])
      .notNull(),
    subtotal: numeric('subtotal', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    deliveryFee: numeric('delivery_fee', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    total: numeric('total', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    // Where the order came from: 'manual' | 'ai_agent' | 'pos'. Lets us tell
    // agent-created orders apart and drive analytics.
    source: text('source').default('manual').notNull(),
    notes: text('notes'),
    // Delivery evidence photo (courier-captured hand-off), uploaded via
    // POST /api/upload/delivery-photo and stored under
    // deliveries/<orgId>/<deliveryOrderId>/. Nullable — a NOT NULL constraint
    // would break every historical row and every org that leaves the
    // `delivery_require_photo` app_setting off; that toggle is enforced instead
    // in transitionDelivery (server-side, defense in depth against the client).
    deliveryPhotoUrl: text('delivery_photo_url'),
    assignedAt: timestamp('assigned_at', { mode: 'date' }),
    inTransitAt: timestamp('in_transit_at', { mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { mode: 'date' }),
    createdBy: text('created_by'),
    // Caller-supplied idempotency key (e.g. the WhatsApp message id). Nullable
    // so existing rows and non-agent callers keep working. A partial UNIQUE index
    // on (organization_id, idempotency_key) WHERE NOT NULL enforces one row per
    // key per org, enabling safe n8n retries.
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    // The courier board and admin list filter org + status, newest first.
    index('delivery_orders_org_status_created_idx').on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    // "My deliveries" for a courier scans org + courier.
    index('delivery_orders_org_courier_idx').on(
      table.organizationId,
      table.courierId,
    ),
    index('delivery_orders_customer_idx').on(table.customerId),
    // Partial UNIQUE index for exactly-once n8n delivery creation. NULL rows
    // (manual, pos, non-idempotent callers) are excluded so many NULLs coexist
    // without violating uniqueness.
    uniqueIndex('delivery_orders_org_idempotency_key_unique_idx')
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
);

export const deliveryEventTypeEnum = pgEnum('delivery_event_type', [
  'created',
  'assigned',
  'status_change',
  'note',
  'customer_notified',
]);

export const deliveryEventsSchema = pgTable(
  'delivery_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryOrderId: uuid('delivery_order_id')
      .notNull()
      .references(() => deliveryOrdersSchema.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    type: deliveryEventTypeEnum('type').notNull(),
    // Set for status_change rows: the transition recorded.
    fromStatus: deliveryStatusEnum('from_status'),
    toStatus: deliveryStatusEnum('to_status'),
    note: text('note'),
    // Who produced the event — courier (cashier), admin (user), agent (api),
    // cron (system). Reuses the audit actor vocabulary.
    actorType: auditActorTypeEnum('actor_type').default('user').notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // The timeline: every event of an order, oldest first.
    index('delivery_events_order_created_idx').on(
      table.deliveryOrderId,
      table.createdAt,
    ),
  ],
);

// ── Courier shifts (delivery money core) ──────────────────────────────────
// A courier declares an EXISTING open caja at the start of their shift; every
// order they mark 'delivered' during the shift becomes a cash (Contraentrega →
// efectivo) POS sale booked into that caja (see transitionDelivery). The shift
// is the bridge that decides WHICH cash session a delivered order's money lands
// in. A partial UNIQUE index guarantees a courier has at most ONE active shift.
export const courierShiftsSchema = pgTable(
  'courier_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // The courier on shift (a pos_user). RESTRICT on delete: a courier with
    // shift history (which drives sale attribution) must not be hard-deleted —
    // employees are deactivated via pos_users.active, never physically removed,
    // so the money trail stays intact.
    courierId: uuid('courier_id')
      .notNull()
      .references(() => posUsersSchema.id, { onDelete: 'restrict' }),
    // The declared caja/device for this shift. A device uuid → that register's
    // till; NULL → the admin/dashboard caja (cash_sessions with a NULL
    // pos_token_id). SET NULL so retiring a device never deletes shift history.
    posTokenId: uuid('pos_token_id').references(() => posTokensSchema.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', { mode: 'date' }).defaultNow().notNull(),
    // NULL while the shift is active; stamped when the courier ends their day.
    endedAt: timestamp('ended_at', { mode: 'date' }),
  },
  table => [
    // At most ONE active shift per courier per org (endedAt IS NULL). Partial so
    // the many ended shifts (endedAt set) coexist without violating uniqueness.
    uniqueIndex('courier_shifts_one_active_per_courier_idx')
      .on(table.organizationId, table.courierId)
      .where(sql`${table.endedAt} IS NULL`),
    // "My shift" lookups scan org + courier.
    index('courier_shifts_org_courier_idx').on(
      table.organizationId,
      table.courierId,
    ),
  ],
);

export const courierShiftsRelations = relations(
  courierShiftsSchema,
  ({ one }) => ({
    courier: one(posUsersSchema, {
      fields: [courierShiftsSchema.courierId],
      references: [posUsersSchema.id],
    }),
    posToken: one(posTokensSchema, {
      fields: [courierShiftsSchema.posTokenId],
      references: [posTokensSchema.id],
    }),
  }),
);

// ── Bolsillo del domiciliario (courier wallet) ─────────────────────────────
// Ledger APPEND-ONLY del efectivo que el domiciliario lleva encima. El saldo se
// DERIVA de estas filas (nunca se guarda un valor absoluto — misma regla que el
// FIFO de stock). Un domiciliario es un pos_user con el módulo 'delivery'. Ver
// docs/caja-domiciliario/ESPECIFICACION.md §3.
//
//   base_from_caja    la caja le presta base para dar vuelto (cajón −$, domi +$)
//   sale_collected    venta a domicilio en efectivo cobrada  (domi +$, NO al cajón)
//   handover_to_caja  entrega billetes a la caja              (domi −$, cajón +$)
//
// Saldo del domiciliario = Σ(base_from_caja + sale_collected) − Σ(handover_to_caja).
export const courierCashDirectionEnum = pgEnum('courier_cash_direction', [
  'base_from_caja',
  'sale_collected',
  'handover_to_caja',
]);

export const courierCashMovementsSchema = pgTable(
  'courier_cash_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // El turno en curso (courier_shifts). SET NULL para no perder el rastro de
    // dinero si un turno se borrara; los turnos no se borran en la práctica.
    shiftId: uuid('shift_id').references(() => courierShiftsSchema.id, {
      onDelete: 'set null',
    }),
    // El domiciliario dueño del bolsillo. RESTRICT: un empleado con rastro de
    // dinero no se borra físicamente (se desactiva con pos_users.active).
    courierId: uuid('courier_id')
      .notNull()
      .references(() => posUsersSchema.id, { onDelete: 'restrict' }),
    // La caja contraparte del movimiento (de dónde salió la base / a dónde entró
    // la entrega). NULL para sale_collected (no toca cajón). SET NULL al retirar
    // el dispositivo para no borrar el historial.
    posTokenId: uuid('pos_token_id').references(() => posTokensSchema.id, {
      onDelete: 'set null',
    }),
    direction: courierCashDirectionEnum('direction').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    // Solo para sale_collected: la venta a domicilio cuyo efectivo se cobró.
    saleId: uuid('sale_id').references(() => salesSchema.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    // pos_user id (o actor) que registró el movimiento. Una sola firma: no hay
    // confirmación de la contraparte (ver ESPECIFICACION §4).
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    // UUID generado en el dispositivo → idempotencia offline (mismo patrón que
    // sale_idempotency_key). La cola offline puede reintentar sin duplicar.
    clientMovementId: uuid('client_movement_id'),
  },
  table => [
    // Idempotencia offline: una fila por (org, client_movement_id). Parcial para
    // que las filas escritas desde el panel (sin client id) sigan válidas.
    uniqueIndex('courier_cash_movements_org_client_idx')
      .on(table.organizationId, table.clientMovementId)
      .where(sql`${table.clientMovementId} IS NOT NULL`),
    // Saldo del domiciliario: escanea org + courier.
    index('courier_cash_movements_org_courier_idx').on(
      table.organizationId,
      table.courierId,
    ),
    index('courier_cash_movements_org_shift_idx').on(
      table.organizationId,
      table.shiftId,
    ),
  ],
);

export const courierCashMovementsRelations = relations(
  courierCashMovementsSchema,
  ({ one }) => ({
    courier: one(posUsersSchema, {
      fields: [courierCashMovementsSchema.courierId],
      references: [posUsersSchema.id],
    }),
    shift: one(courierShiftsSchema, {
      fields: [courierCashMovementsSchema.shiftId],
      references: [courierShiftsSchema.id],
    }),
    posToken: one(posTokensSchema, {
      fields: [courierCashMovementsSchema.posTokenId],
      references: [posTokensSchema.id],
    }),
  }),
);

// ── Operating expenses (P&L ledger) ───────────────────────────────────────
// Business expenses the owner registers for net-profit tracking.
// This is the P&L operating-expense ledger — intentionally SEPARATE from
// cash_movements, which is the physical cash-drawer ledger (caja). An expense
// recorded here affects the profit calculation without requiring the cash drawer
// to be open. The two concepts must never be merged: caja tracks physical money
// flow; this ledger tracks economic cost allocated to a period.
//
// Suggested categories (used by the UI): servicios, arriendo, transporte,
// marketing, impuestos, otros.
export const expensesSchema = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    // Open-ended text so the owner is not forced into our taxonomy. UI suggests:
    // servicios | arriendo | transporte | marketing | impuestos | otros.
    category: text('category').notNull(),
    description: text('description'),
    // The date the expense APPLIES TO (economic date), not the recording date.
    // Net-profit queries filter incurred_on within the selected date range.
    incurredOn: date('incurred_on').notNull(),
    // Clerk userId of the owner who logged this entry.
    createdBy: text('created_by'),
    // Set on a reversing (negative-amount) correction row: points at the
    // original expense it cancels. The column — NOT the description string — is
    // the source of truth for "already corrected". A PARTIAL UNIQUE index
    // (migration 0059) guarantees an original can be reversed AT MOST once, so
    // concurrent double-corrections collide at the DB. FK ON DELETE RESTRICT
    // mirrors the expense_id linkage precedent (migrations 0048/0058). Not
    // .references() inline to avoid a self-referential forward declaration in
    // the same table; the FK is enforced via migration 0059.
    reversesExpenseId: uuid('reverses_expense_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // Net-profit queries scan org + incurred_on; this covers most date-range filters.
    index('expenses_org_incurred_on_idx').on(
      table.organizationId,
      table.incurredOn,
    ),
  ],
);

// ── Treasury movements (Phase 2B) ─────────────────────────────────────────
// Unified ledger for inter-container transfers, consignaciones, gastos, and
// external in/out flows. Defined after treasury_accounts + expenses because its
// FKs reference them. Balance formula per container:
//   opening_balance + SUM(amount WHERE to_account_id = id)
//                   − SUM(amount WHERE from_account_id = id)
// Constraint: exactly one of from/to may be NULL (external flow), or both
// must be set (transfer/consignacion). Neither may BOTH be NULL.
// NOTE: the CHECK constraint is hand-appended to migration 0046 because
// drizzle-kit does not emit raw CHECK clauses.
export const treasuryMovementsSchema = pgTable(
  'treasury_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // NULL = external source (entrada) / external destination (salida/gasto).
    fromAccountId: uuid('from_account_id').references(
      () => treasuryAccountsSchema.id,
      { onDelete: 'restrict' },
    ),
    toAccountId: uuid('to_account_id').references(
      () => treasuryAccountsSchema.id,
      { onDelete: 'restrict' },
    ),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    type: treasuryMovementTypeEnum('type').notNull(),
    category: text('category'),
    reason: text('reason'),
    // Linked expenses row for gasto movements (RESTRICT on delete: an expenses
    // row MUST NOT be deleted while a linked treasury_movements row exists).
    expenseId: uuid('expense_id').references(() => expensesSchema.id, {
      onDelete: 'restrict',
    }),
    // Set on the 'entrada' deposit created when a customer transfer is confirmed.
    // The unique index makes confirming a transfer credit its bank exactly once.
    transferReconciliationId: uuid('transfer_reconciliation_id').references(
      () => transferReconciliationsSchema.id,
      { onDelete: 'restrict' },
    ),
    // Set on placement movements to tag the originating handover row (N:1 — NOT unique).
    // NULL on all non-placement movements.
    // FK is enforced via migration 0053 (self-referential FK: omitting .references() here
    // to avoid the TypeScript TS7022 circular-initializer error on self-referential tables).
    handoverMovementId: uuid('handover_movement_id'),
    // Set ONLY on type='handover' rows to link back to the cash session that was closed.
    // NULL on all other movement types.
    cashSessionId: uuid('cash_session_id').references(
      () => cashSessionsSchema.id,
      { onDelete: 'set null' },
    ),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  t => [
    index('treasury_movements_org_idx').on(t.organizationId),
    index('treasury_movements_from_idx').on(t.fromAccountId),
    index('treasury_movements_to_idx').on(t.toAccountId),
    // One deposit per confirmed transfer (NULLs allowed for all other movements).
    uniqueIndex('treasury_movements_transfer_recon_unique').on(
      t.transferReconciliationId,
    ),
    // Placement query index: find all placements for a given handover (N:1 — NOT unique).
    index('treasury_movements_handover_idx').on(t.handoverMovementId),
    // Session → handover link for the caja card 'entregado' query.
    index('treasury_movements_session_idx').on(t.cashSessionId),
  ],
);

// ── Staff absences and coverage ───────────────────────────────────────────
// Tracks planned rest days and unplanned absences for pos_users. When an
// employee can't come (status='open'), the owner finds a replacement using
// findAvailableReplacements (employees whose schedule marks that day as off or
// has no fixed schedule for it). The owner assigns coverage (covered_by) and
// optionally notifies the replacement via WhatsApp.
//
// Kinds: 'absence' = no puede venir (unplanned), 'break' = descanso programado
// Status lifecycle: 'open' → 'covered' (assigned) | 'cancelled'
export const staffAbsencesSchema = pgTable(
  'staff_absences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // The employee who is off. CASCADE delete: removing the employee removes their absences.
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => posUsersSchema.id, { onDelete: 'cascade' }),
    // The date the absence applies to (plain calendar date, no time zone in DB).
    date: date('date').notNull(),
    // 'absence' | 'break'
    kind: text('kind').notNull(),
    reason: text('reason'),
    // 'open' | 'covered' | 'cancelled'
    status: text('status').default('open').notNull(),
    // Set when a replacement is assigned. SET NULL if that employee is deleted.
    coveredBy: uuid('covered_by').references(() => posUsersSchema.id, {
      onDelete: 'set null',
    }),
    // Set when a WhatsApp notification was successfully sent to the replacement.
    notifiedAt: timestamp('notified_at', { mode: 'date' }),
    // Clerk user id of the owner who registered the absence.
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // Roster queries and date-range lookups scan by org + date.
    index('staff_absences_org_date_idx').on(table.organizationId, table.date),
  ],
);

export const staffAbsencesRelations = relations(
  staffAbsencesSchema,
  ({ one }) => ({
    employee: one(posUsersSchema, {
      fields: [staffAbsencesSchema.employeeId],
      references: [posUsersSchema.id],
      relationName: 'absent_employee',
    }),
    coveredByEmployee: one(posUsersSchema, {
      fields: [staffAbsencesSchema.coveredBy],
      references: [posUsersSchema.id],
      relationName: 'covering_employee',
    }),
  }),
);

export const deliveryOrdersRelations = relations(
  deliveryOrdersSchema,
  ({ one, many }) => ({
    customer: one(customersSchema, {
      fields: [deliveryOrdersSchema.customerId],
      references: [customersSchema.id],
    }),
    sale: one(salesSchema, {
      fields: [deliveryOrdersSchema.saleId],
      references: [salesSchema.id],
    }),
    courier: one(posUsersSchema, {
      fields: [deliveryOrdersSchema.courierId],
      references: [posUsersSchema.id],
    }),
    events: many(deliveryEventsSchema),
  }),
);

export const deliveryEventsRelations = relations(
  deliveryEventsSchema,
  ({ one }) => ({
    order: one(deliveryOrdersSchema, {
      fields: [deliveryEventsSchema.deliveryOrderId],
      references: [deliveryOrdersSchema.id],
    }),
  }),
);

// ── Supplier accounts-payable (migration 0065) ────────────────────────────────
//
// ── supplier_purchases (migration 0069) ──────────────────────────────────────
// Optional invoice header: groups N purchase-entry payables under a single
// "factura" (physical invoice). Standalone payables (no invoice) keep
// purchase_id = null — fully back-compatible.
//
// Design decisions:
//   - supplier_id is TEXT (no FK) — mirrors stock_movements.supplier_id (D1).
//   - invoice_number is nullable; unique only within (org, supplier, non-null).
//   - Outstanding/paid on the invoice is computed at read (SUM over lines); no
//     stored header denorm in v1 (small N per invoice, cheap to recompute).

export const supplierPurchasesSchema = pgTable(
  'supplier_purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // TEXT (no FK) — mirrors stock_movements.supplier_id convention (D1).
    supplierId: text('supplier_id').notNull(),
    // Physical invoice number from the supplier (optional, nullable).
    invoiceNumber: text('invoice_number'),
    purchasedAt: timestamp('purchased_at', { mode: 'date' }).defaultNow().notNull(),
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    // Per-supplier invoice history.
    index('supplier_purchases_org_supplier_idx').on(
      table.organizationId,
      table.supplierId,
    ),
    // Date-range scan for "Compras por pagar" grouped view.
    index('supplier_purchases_org_purchased_idx').on(
      table.organizationId,
      table.purchasedAt,
    ),
    // Prevent duplicate invoice_number per supplier within an org.
    // Partial: only enforced when invoice_number IS NOT NULL.
    uniqueIndex('supplier_purchases_org_supplier_invoice_unique')
      .on(table.organizationId, table.supplierId, table.invoiceNumber)
      .where(sql`${table.invoiceNumber} IS NOT NULL`),
  ],
);

// One supplier_payables header per purchase entry (created inside the same tx as
// stock_movements). One supplier_payments row per payment event — N payments can
// reference the same payable (multi-payment N:M in v1 via direct nullable FK).
// Payments debit a treasury container (salida), not expenses (ASSET, not P&L).
// Mirror the creditos shape: denormalized paid_amount + status for fast list scans.

export const supplierPayableStatusEnum = pgEnum('supplier_payable_status', [
  'open',
  'partial',
  'paid',
]);

// Header: one per purchase entry lot. totalAmount is frozen at creation.
export const supplierPayablesSchema = pgTable(
  'supplier_payables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // TEXT (no FK) — mirrors stock_movements.supplier_id convention (D1).
    supplierId: text('supplier_id').notNull(),
    // The entry lot. RESTRICT: lot must not be deleted while a payable exists.
    stockMovementId: uuid('stock_movement_id').references(
      () => stockMovementsSchema.id,
      { onDelete: 'restrict' },
    ),
    // Frozen at qty × unitCost at purchase time. Never recomputed retroactively.
    totalAmount: numeric('total_amount', { precision: 12, scale: 2 }).notNull(),
    // Denormalized for fast SUM queries (D4). Updated atomically with each payment.
    paidAmount: numeric('paid_amount', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    // Denormalized sum of all credit chunks applied against this payable.
    // Updated atomically with each supplier_payable_credits insert.
    creditedAmount: numeric('credited_amount', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    status: supplierPayableStatusEnum('status').default('open').notNull(),
    purchasedAt: timestamp('purchased_at', { mode: 'date' })
      .defaultNow()
      .notNull(),
    // Optional invoice grouping (migration 0069). NULL = standalone purchase.
    // SET NULL if the invoice header is ever deleted (keeps payable intact).
    purchaseId: uuid('purchase_id').references(
      () => supplierPurchasesSchema.id,
      { onDelete: 'set null' },
    ),
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    // Per-supplier history and totalPaid lookup (KPI).
    index('supplier_payables_org_supplier_idx').on(
      table.organizationId,
      table.supplierId,
    ),
    // Open-list filter + pendingPayments KPI.
    index('supplier_payables_org_status_idx').on(
      table.organizationId,
      table.status,
    ),
    // Date-range scan on the "Compras por pagar" list (purchased_at DESC).
    index('supplier_payables_org_purchased_idx').on(
      table.organizationId,
      table.purchasedAt,
    ),
    // One payable per entry lot. Idempotent backfill-safe (mirrors creditos_sale_unique_idx).
    uniqueIndex('supplier_payables_stock_movement_unique')
      .on(table.stockMovementId)
      .where(sql`${table.stockMovementId} IS NOT NULL`),
    // Invoice grouping index (migration 0069).
    index('supplier_payables_purchase_id_idx').on(table.purchaseId),
  ],
);

// Ledger: one row per payment event. Many rows may reference the same payable.
// Migration 0071: exactly-one funding source enforced by DB CHECK.
// - treasury-funded: treasury_movement_id set, cash_movement_id NULL.
// - caja-funded:     cash_movement_id set, treasury_movement_id NULL.
export const supplierPaymentsSchema = pgTable(
  'supplier_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    supplierId: text('supplier_id').notNull(),
    // Nullable for future ad-hoc payments that don't link to a specific payable.
    // SET NULL if a payable is ever purged — keeps the payment ledger intact.
    payableId: uuid('payable_id').references(
      () => supplierPayablesSchema.id,
      { onDelete: 'set null' },
    ),
    // Treasury-funded path: the salida treasury_movements row.
    // NULL for caja-funded rows (migration 0071 drops NOT NULL).
    // Enforced non-null at app layer for treasury-funded payments.
    treasuryMovementId: uuid('treasury_movement_id').references(
      () => treasuryMovementsSchema.id,
      { onDelete: 'restrict' },
    ),
    // Caja-funded path (migration 0071): the expense cash_movements row written
    // by recordCajaPayableSettle. NULL for treasury-funded rows.
    // CHECK (num_nonnulls(treasury_movement_id, cash_movement_id) = 1) ensures
    // exactly one funding source is set.
    cashMovementId: uuid('cash_movement_id').references(
      () => cashMovementsSchema.id,
      { onDelete: 'restrict' },
    ),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // Per-supplier payment history.
    index('supplier_payments_org_supplier_idx').on(
      table.organizationId,
      table.supplierId,
    ),
    // Payments for a given payable (settling multiple installments).
    index('supplier_payments_payable_idx').on(table.payableId),
    // paidThisMonth window: date_trunc('month', now()) scan (mirrors credito movements idx).
    index('supplier_payments_org_created_idx').on(
      table.organizationId,
      table.createdAt,
    ),
    // Migration 0071: exactly-one funding source enforced at the DB layer.
    // treasury-funded: treasury_movement_id set, cash_movement_id NULL.
    // caja-funded:     cash_movement_id set, treasury_movement_id NULL.
    check(
      'supplier_payments_funding_source_chk',
      sql`num_nonnulls(${table.treasuryMovementId}, ${table.cashMovementId}) = 1`,
    ),
  ],
);

// Credit ledger: one row per credit chunk applied to a payable during a return.
// A single return_supplier exit may split its value across N payables (FIFO),
// writing one supplier_payable_credits row per payable chunk. Total of all
// chunk amounts = applyReturnCredit result.appliedTotal.
//
// Design decisions:
//   - payable_id is nullable (SET NULL): a purged payable orphans the credit
//     row but the return stock_movement row stays (RESTRICT on that FK).
//   - total_amount on supplier_payables is NEVER mutated (REQ immutability).
//   - paidThisMonth KPI reads supplier_payments only (credits ≠ cash).
export const supplierPayableCreditsSchema = pgTable(
  'supplier_payable_credits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // TEXT (no FK) — mirrors supplier_payables.supplier_id convention (D1).
    supplierId: text('supplier_id').notNull(),
    // The payable this credit chunk reduced. SET NULL if payable is purged.
    payableId: uuid('payable_id').references(
      () => supplierPayablesSchema.id,
      { onDelete: 'set null' },
    ),
    // The return exit stock_movements row that originated this credit.
    // RESTRICT: the return movement must not be deleted while credits exist.
    returnStockMovementId: uuid('return_stock_movement_id')
      .notNull()
      .references(() => stockMovementsSchema.id, { onDelete: 'restrict' }),
    // Amount applied to THIS payable chunk (sum ≤ return value).
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // Per-supplier credit history and outstanding recalculation.
    index('supplier_payable_credits_org_supplier_idx').on(
      table.organizationId,
      table.supplierId,
    ),
    // Payable-level credit lookup (recompute credited_amount if needed).
    index('supplier_payable_credits_payable_idx').on(table.payableId),
    // Return movement → all credit chunks for that return.
    index('supplier_payable_credits_return_movement_idx').on(
      table.returnStockMovementId,
    ),
    // Date-range scans across credits.
    index('supplier_payable_credits_org_created_idx').on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

// Cash-back ledger: one row per supplier refund event.
// Created when a returned lot's value exceeds the supplier's outstanding balance —
// the excess comes back as real cash (inflow into a container).
//
// Mirrors supplier_payments shape:
//   - treasury_movement_id NOT NULL RESTRICT: every refund must reference a real
//     treasury_movements row (type='refund', from=null, to=container).
//   - payable_id nullable (SET NULL): payable may be purged; refund stays on record.
//   - stock_movement_id: the EXIT stock_movements row for this return. RESTRICT.
//   - Does NOT write supplier_payments → paidThisMonth KPI is unaffected.
export const supplierRefundsSchema = pgTable(
  'supplier_refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // TEXT (no FK) — mirrors supplier_payables.supplier_id convention (D1).
    supplierId: text('supplier_id').notNull(),
    // The payable this refund is linked to. SET NULL if payable is purged.
    payableId: uuid('payable_id').references(
      () => supplierPayablesSchema.id,
      { onDelete: 'set null' },
    ),
    // The EXIT stock_movements row (the return lot exit, same tx). RESTRICT.
    stockMovementId: uuid('stock_movement_id')
      .notNull()
      .references(() => stockMovementsSchema.id, { onDelete: 'restrict' }),
    // The treasury_movements row (type='refund', from=null, to=container). RESTRICT.
    treasuryMovementId: uuid('treasury_movement_id')
      .notNull()
      .references(() => treasuryMovementsSchema.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    // Per-supplier refund history.
    index('supplier_refunds_org_supplier_idx').on(
      table.organizationId,
      table.supplierId,
    ),
    // Payable-level refund lookup.
    index('supplier_refunds_payable_idx').on(table.payableId),
    // Return movement → refund row.
    index('supplier_refunds_stock_movement_idx').on(table.stockMovementId),
    // Date-range scans.
    index('supplier_refunds_org_created_idx').on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

// ── AI Agent backbone (delivery-agent-backbone) ────────────────────────────
// Three enums + three tables that back the n8n ↔ merchantai agent integration.
// Migration: 0074_agent_backbone (additive only — no DROP/ALTER on existing tables).

export const conversationStatusEnum = pgEnum('conversation_status', [
  'active',
  'handoff',
  'closed',
]);

export const messageDirectionEnum = pgEnum('message_direction', [
  'inbound',
  'outbound',
]);

export const messageSenderTypeEnum = pgEnum('message_sender_type', [
  'customer',
  'bot',
  'human',
]);

// One agent API token per WhatsApp channel. Created automatically when a channel
// completes QR pairing; can be regenerated or revoked by an admin.
// Auth flow: raw-db lookup resolves org from the token row; then db.forOrg scopes
// the channel/capabilities query (mirrors pos-auth.ts:50).
export const agentTokensSchema = pgTable(
  'agent_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    // FK set-null on channel delete: orphaned tokens → channelId=null → 401.
    channelId: uuid('channel_id').references(() => whatsappChannelsSchema.id, {
      onDelete: 'set null',
    }),
    // The bearer token value. UUID format, generated randomly at issuance.
    // Mirrors pos_tokens.token (Schema.ts:858).
    token: uuid('token').notNull().defaultRandom(),
    description: text('description').notNull(),
    active: boolean('active').default(true).notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date' }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('agent_tokens_token_unique_idx').on(table.token),
    index('agent_tokens_org_idx').on(table.organizationId),
  ],
);

// One conversation per (org, channel, remoteJid) triple. Upserted on every
// inbound message from n8n; carries bot-control state (pause / handoff).
// channelId is NOT NULL + restrict to preserve history; caller must delete
// conversations before deleting a channel (see deleteWhatsAppChannel).
export const conversationsSchema = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => whatsappChannelsSchema.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').references(() => customersSchema.id, {
      onDelete: 'set null',
    }),
    remoteJid: text('remote_jid').notNull(),
    status: conversationStatusEnum('status').default('active').notNull(),
    botPaused: boolean('bot_paused').default(false).notNull(),
    botPausedUntil: timestamp('bot_paused_until', { mode: 'date' }),
    botPausedBy: text('bot_paused_by'),
    // 'bot' = automated; set to a user id on handoff.
    attendedBy: text('attended_by').default('bot').notNull(),
    // Owner blocked this number from the inbox: the bot must stay silent even
    // when not paused. n8n reads this flag from the upsert response.
    blocked: boolean('blocked').default(false).notNull(),
    lastMessageAt: timestamp('last_message_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    uniqueIndex('conversations_org_channel_jid_unique_idx').on(
      table.organizationId,
      table.channelId,
      table.remoteJid,
    ),
    index('conversations_org_status_idx').on(table.organizationId, table.status),
    index('conversations_customer_idx').on(table.customerId),
  ],
);

// Individual messages within a conversation. Persists both inbound (customer →
// bot) and outbound (bot/human → customer) from day one.
// externalId: the Evolution API message id, used for dedup (partial unique).
export const messagesSchema = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversationsSchema.id, { onDelete: 'cascade' }),
    // External message id from the WhatsApp gateway (nullable: outbound may lack it).
    externalId: text('external_id'),
    direction: messageDirectionEnum('direction').notNull(),
    senderType: messageSenderTypeEnum('sender_type').notNull(),
    senderId: text('sender_id'),
    contentType: text('content_type').default('text').notNull(),
    body: text('body'),
    // Arbitrary gateway metadata (media urls, quoted messages, etc.).
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  table => [
    index('messages_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
    ),
    // Partial unique: only enforce dedup when externalId is provided.
    // Mirrors customers.ts:1185 pattern.
    uniqueIndex('messages_org_external_unique_idx')
      .on(table.organizationId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
  ],
);
