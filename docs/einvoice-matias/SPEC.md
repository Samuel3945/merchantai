# SPEC — MATIAS electronic invoicing module (replaces Factus)

> Status: DRAFT (FASE 2). Spec-driven. Sandbox only.
> Author: integration agent. Last update: 2026-06-25.

## 0. Context & decisions

MerchantAI is a multi-tenant POS (each business = one tenant = one NIT). We are
**replacing the Factus e-invoicing provider with MATIAS API** and removing every
trace of Factus from live code.

MATIAS runs the open-source `lopezsoft` UBL 2.1 (Laravel) stack. Authoritative
references used to build this spec:

- Sandbox base URL: `https://sandbox-api.matias-api.com/api/ubl2.1` (the ONLY
  environment we target — production is never configured in code).
- Auth: `POST /auth/login` `{email,password}` → `{access_token, token_type:"Bearer",
  expires_at}` (≈90 days). Optional long-lived PAT via `POST /auth/token`.
- Emission: `POST /invoice` (factura `type_document_id:7`, POS `:20`, cine `:25`,
  SPD `:60`), `POST /notes/credit` (`:5`), `POST /notes/debit` (`:4`).
- Status: `/status`. Numbering: `GET /numbering-range` (+ autoincrement endpoints).
- Response: CUFE/CUDE in `XmlDocumentKey` (a.k.a. `document_key`); DIAN status in
  `StatusCode` (`"00"` = approved); `XmlFileName` = document number; `pdf.{url,data}`,
  `AttachedDocument.{url,data}` = signed XML, `qr.{url,data}`; root `success:true`.
  Sandbox responses carry header `X-MATIAS-Environment: sandbox`.

### Key business-model decision — "Casa de Software"

MATIAS plan = **Casa de Software / Software Propio**: ONE MATIAS account for all of
MerchantAI, one shared document pool. Therefore:

- The MATIAS **account credentials are app-level** (one account), stored in env, not
  per tenant. The OAuth token is cached **app-level** (one account → one token).
- **Per-tenant** data = the tenant's NIT, its DIAN numbering resolution + prefix, and
  its certificate state. This lives in the DB, org-scoped, sensitive parts encrypted.
- Credits are consumed **per emitted document**, per tenant (same mechanism as AI
  actions).

> ⚠️ OPEN QUESTION (confirm during impl from the company/config + autoincrement
> endpoint docs, or MATIAS support): exactly how one MATIAS account emits on behalf
> of multiple NITs (per-tenant company registration / sub-token / company id in the
> request). The adapter MUST isolate this so the rest of the system is unaffected.
> Until confirmed, the sandbox uses the account's default test company.

### Reused architecture (do not reinvent)

The current module is already ports & adapters. We keep the shape and swap the
provider:

- `src/libs/einvoice/config.ts` — load per-tenant config (rewrite for MATIAS).
- `src/libs/einvoice/<provider>-adapter.ts` — the ONLY module that knows the HTTP
  contract (replace `factus-adapter.ts` with `matias-adapter.ts`).
- `src/libs/einvoice/emit.ts` — orchestration: idempotency, retries, persistence,
  best-effort auto hooks (keep; rewrite payload builders for MATIAS JSON).
- `src/actions/einvoice.ts` — server actions: list, manual emit/retry, test
  connection (rewrite provider checks + test-connection to MATIAS login).
- `src/features/einvoice/InvoicesClient.tsx` — Facturas module UI.
- `src/features/settings/FiscalTab.tsx` — settings UI (replace Factus creds with
  per-tenant fiscal config + certificate state).
- `src/models/Schema.ts` — `sales.einvoice_*` mirror + `einvoice_emissions` trail.

## 1. Data model

### 1.1 App-level config (env, validated in `src/libs/Env.ts`)

```
MATIAS_API_BASE_URL   = https://sandbox-api.matias-api.com/api/ubl2.1
MATIAS_ACCOUNT_EMAIL  = <casa-de-software account email>
MATIAS_ACCOUNT_PASSWORD = <secret>
```

Never committed; live in the VPS environment (Easypanel) and a gitignored
`.env.local` for local dev. Base URL is locked to sandbox; production requires a
deliberate, separate change.

### 1.2 Per-tenant config (`app_settings`, org-scoped)

Reuse the existing settings-key pattern. Keys:

| Key | Meaning |
| --- | --- |
| `fiscal_einvoice_provider` | `'matias'` \| `'none'` |
| `fiscal_nit` | tenant NIT (emitter) — already exists |
| `fiscal_dian_resolution` | DIAN resolution description — already exists |
| `einvoice_matias_resolution_number` | numbering resolution number (e.g. `18764074347312`) |
| `einvoice_matias_prefix` | numbering prefix (e.g. `FEV`, `FPOS`) |
| `einvoice_cert_status` | `'none'` \| `'activating'` \| `'active'` |
| `einvoice_auto` | `'1'` \| `'0'` — auto-invoicing toggle |

Sensitive per-tenant data (only when a tenant uploads its OWN `.p12`): the cert blob
and its password are stored **encrypted** (AES-GCM with a key from env), never in
plaintext. In sandbox, MATIAS auto-provisions a test cert → `einvoice_cert_status`
is `'active'` with no upload.

`configured` (a tenant can emit) = provider is `matias` AND `fiscal_nit` AND
`einvoice_matias_resolution_number` are present AND `einvoice_cert_status='active'`.

### 1.3 Emitted-documents trail (`einvoice_emissions` — extend existing)

Keep the table; adjust defaults + add MATIAS result fields:

- `provider` default → `'matias'`.
- `kind`: `'invoice'` \| `'pos'` \| `'credit_note'` \| `'debit_note'`.
- existing: `status` (`queued|sent|emitted|failed`), `cufe`, `number`, `providerId`,
  `customer` (jsonb), `payload` (jsonb), `response` (jsonb), `attempts`, `lastError`,
  `emittedAt`, `createdBy`.
- ADD: `pdf_url` text, `xml_url` text, `qr_data` text (or jsonb `artifacts`),
  `dian_status` text (raw `StatusCode`), `credits_consumed` integer default 0.

`sales.einvoice_status/cufe/number/id` mirror the latest successful emission for
cheap listing (unchanged).

## 2. Flows

### 2.1 Onboarding a new NIT (per tenant)

1. Admin opens Ajustes → Fiscal, sets NIT, DIAN resolution number + prefix.
2. System ensures the NIT is registered as a company under the Casa de Software
   MATIAS account (company/config endpoint — confirm during impl). Sandbox: default
   test company.
3. Certificate: in sandbox, auto-active. In production, either activate as add-on
   (status `activating` → `active` when MATIAS confirms) or upload own `.p12`
   (encrypted at rest).
4. "Test connection" verifies the MATIAS login works (app-level) and the tenant's
   config is complete.

### 2.2 Emission per sale

1. A sale carries invoice intent in `notes`: `[FACTURA] Nombre:… | Doc:… | WA:… |
   Correo:… | Direccion:…`. No tag (or `CONSUMIDOR_FINAL`) ⇒ bill to "Consumidor
   final". (Existing behavior — kept.)
2. `emitInvoiceForSale(org, saleId)`:
   - Gate on `configured`; else Spanish "not configured" error.
   - Idempotent: an already-`emitted` sale is a no-op unless `force` (retry).
   - Build the MATIAS payload (see §3), call `MatiasAdapter.emit*`, persist the
     attempt to `einvoice_emissions`, mirror to `sales`, consume credits on success.
3. Document kind: a POS sale emits a **POS electrónico** (`type_document_id:20`) by
   default; a sale tagged as a formal `factura` emits `type_document_id:7`. (Decision:
   default POS for cashier sales; formal invoice on explicit request.)

### 2.3 Auto-invoicing toggle

- `einvoice_auto` per tenant. When ON, `maybeAutoEmitInvoice(org, saleId)` runs
  fire-and-forget right after a successful sale (best-effort: never blocks or fails
  the sale). When OFF, emission is manual from the Facturas module.
- Returns void an emitted invoice via `maybeEmitCreditNote` (best-effort) when ON.

### 2.4 DIAN error handling & retry

- The adapter throws a typed error `{status, code, body}`. `emit.ts` records
  `status='failed'` + `lastError` + raw `response`, mirrors `sales.einvoice_status='failed'`.
- Retry: manual from Facturas (`force`), or a bounded auto-retry for transient
  errors (HTTP 5xx / timeout) with backoff; permanent DIAN rejections (`StatusCode`
  business errors) are NOT auto-retried — they need data fixes.
- Sandbox `X-Sandbox-Force-Status` magic values are used in tests to exercise each
  failure branch.

### 2.5 Credit consumption

- On a successful emission, consume N credits for the tenant via the existing
  credits/usage mechanism (same as AI/OpenAI actions). Record `credits_consumed` on
  the emission row. If the tenant has no credits, block emission with a clear Spanish
  message BEFORE calling MATIAS (no wasted DIAN document).

## 3. MATIAS payloads (from official examples)

### 3.1 Invoice (`type_document_id:7`) / POS (`:20`)

Top level: `resolution_number`, `prefix`, `document_number`, `notes`,
`graphic_representation` (1 to get PDF), `send_email`, `operation_type_id:1`,
`type_document_id`, `document_signature{cashier,seller}`, `payments[]`
(`payment_method_id`, `means_payment_id`, `value_paid`), `customer{}` (omit for POS
final consumer), `lines[]`, `legal_monetary_totals{}`, `tax_totals[]`.

POS adds `point_of_sale{cashier_name,terminal_number,cashier_type,sales_code,
address,sub_total}` and `software_manufacturer{owner_name,company_name,software_name}`.

`customer`: `country_id`, `city_id`, `identity_document_id`, `type_organization_id`,
`tax_regime_id`, `tax_level_id`, `company_name`, `dni`, `mobile`, `email`, `address`,
`postal_code`.

`lines[]`: `invoiced_quantity`, `quantity_units_id` (`1093`), `line_extension_amount`,
`free_of_charge_indicator`, `description`, `code`, `type_item_identifications_id`
(`4`), `reference_price_id`, `price_amount`, `base_quantity`, `tax_totals[]`
(`tax_id`, `tax_amount`, `taxable_amount`, `percent`). `tax_id:1` = IVA.

`legal_monetary_totals`: `line_extension_amount`, `tax_exclusive_amount`,
`tax_inclusive_amount`, `payable_amount`.

`document_number` = consecutive within the tenant's resolution range. Use MATIAS
autoincrement endpoints when available (confirm during impl) so we don't track
consecutives ourselves.

### 3.2 Credit note (`/notes/credit`, `type_document_id:5`)

References the original document (`billing_reference` / original `document_key`) +
`discrepancy_response`. Read `docs/jsons-billing/credit-note.md` during impl.

## 4. Edge cases & Spanish user-facing messages

| Case | Message (ES) |
| --- | --- |
| Provider not configured | "Falta configurar la facturación electrónica en Ajustes → Fiscal." |
| Missing NIT / resolution | "Configurá el NIT y la resolución de numeración antes de emitir." |
| Certificate not active | "El certificado de facturación aún no está activo para este negocio." |
| No credits | "No te quedan créditos de facturación. Recargá para seguir emitiendo." |
| DIAN rejected (business) | "La DIAN rechazó el documento: {motivo}. Revisá los datos y reintentá." |
| Transient (5xx/timeout) | "La DIAN no respondió a tiempo. Lo reintentamos automáticamente." |
| Already emitted | (idempotent no-op; show existing CUFE) |
| Sale not found / no items | "Venta no encontrada." / "La venta no tiene productos." |

All adapter/emit errors surface a clear Spanish message; raw provider bodies are
stored in `einvoice_emissions.response` for debugging, never shown raw to the user.

## 5. Out of scope (this change)

- Electronic payroll (nómina), support documents (documento soporte) beyond what
  the sale flow needs, RADIAN events. The adapter leaves room but we don't wire them.
- Production emission (real DIAN). Sandbox only until the tenant has a contract +
  real certificate.

## 6. Verification (FASE 4)

- `tsc` + build pass; unit tests for payload builders + response parsing.
- `rg -i factus src` returns nothing (live code clean).
- Real sandbox emission returns a CUFE (`XmlDocumentKey`) with `StatusCode:"00"`
  (BLOCKED until the account is replicated to sandbox — see integration notes).
- Token cache + per-tenant isolation verified.
