# MerchantAI — App Conventions

## Inventory & stock ledger

The single source of truth for stock is the **FIFO ledger** in `stock_movements`.
`products.stock` must always equal `SUM(remaining_qty)` of that product's open
`entry` lots. Two rules keep that invariant:

1. **Never set `products.stock` to an absolute value.** Stock only moves by
   `+qty` (entry) or `GREATEST(0, stock - qty)` (exit). The old `adjustment`
   movement (type `adjustment`, reason `inventory_count`) set stock absolutely
   and desynced `remaining_qty` from `stock` — it is **retired**. No flow writes
   `adjustment` anymore; the type/reason survive only so historical rows still
   read. There is no "Conteo" button.

2. **Sales own their own stock effect.** `actions/sales.ts` and
   `libs/sale-returns.ts` decrement stock and insert their `exit` (reason
   `sale`) / restock movements inside one transaction, consuming FIFO lots via
   `libs/fifo-cogs.ts#consumeFifoExits`. **Inventory never re-emits a movement
   for a sale** — doing so double-discounts stock. Inventory only records manual
   `entry` / `exit`.

### Reconciling a physical count (no Conteo flow)

When the shelf count differs from the system:

- **Shelf has FEWER units** → register a **Salida (exit)**. Use reason
  `lost` ("Se perdió o me lo robaron") or `manual` ("Otro motivo") with a note
  like `faltante de conteo`.
- **Shelf has MORE units** → register an **Entrada (entry)** with reason
  `manual` and a note like `sobrante de conteo` (also used for initial
  inventory).

Both paths run through the FIFO ledger, so `products.stock = SUM(remaining_qty)`
stays true and cost/expiration valuation stays accurate.

### "Otro motivo" (`reason = 'manual'`) requires a note

A manual reason demands a free-text explanation. It is enforced in **two
layers**: the client disables confirm while the note is empty, and
`recordMovement` throws (and writes nothing) if `reason === 'manual'` and the
note is blank. The note is persisted in `stock_movements.notes`.

### Smart Stock (minimum stock)

`products.minStock` is **manual by default** (editable inline in the table).
**Smart Stock** is a deterministic heuristic (`libs/smart-stock.ts`, NOT an LLM)
that auto-maintains the minimum from 30-day sales velocity. It only runs when the
org is on a paid plan (`pro`/`business`) AND the `smartStockEnabled` flag in
`app_settings` is on. The toggle lives in **Agente IA → Modelos Inteligentes**
(Pro-only). While on, the "Min" column is read-only with an "IA" mark. Inventory
only READS the flag; it never flips it.

### Auditing

Every inventory mutation writes `audit_logs` via `libs/audit-log.ts#logAction`
(actor = Clerk user, before/after stock). The movement history resolves
`created_by` (Clerk user id) to a readable name for the "Quién" column.
