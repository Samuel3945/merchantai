import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { Env } from '@/libs/Env';
import { appSettingsSchema } from '@/models/Schema';

// MATIAS e-invoicing configuration.
//
// "Casa de Software" model: ONE MATIAS account for the whole platform. The account
// credentials are app-level (env, NEVER per tenant). What varies per tenant lives
// in `app_settings` (org-scoped): the emitter NIT, the DIAN numbering resolution +
// prefix, the certificate state and the auto-emit toggle.
//
// Secrets are never committed: the MATIAS account password lives in the VPS
// environment; per-tenant certificate material (only when a tenant uploads its own
// .p12) is stored encrypted.

export const EINV_KEYS = {
  provider: 'fiscal_einvoice_provider', // 'matias' | 'none'
  emitterNit: 'fiscal_nit',
  resolution: 'fiscal_dian_resolution',
  resolutionNumber: 'einvoice_matias_resolution_number',
  prefix: 'einvoice_matias_prefix',
  certStatus: 'einvoice_cert_status', // 'none' | 'activating' | 'active'
  autoEmit: 'einvoice_auto', // '1' | '0'
} as const;

export type CertStatus = 'none' | 'activating' | 'active';

export type EInvoiceConfig = {
  provider: string;
  matias: {
    baseUrl: string;
    email: string | null;
    password: string | null;
  };
  emitterNit: string | null;
  resolution: string | null;
  resolutionNumber: string | null;
  prefix: string | null;
  certStatus: CertStatus;
  autoEmit: boolean;
  /** True only when provider is MATIAS AND everything needed to emit is present. */
  configured: boolean;
};

function normalizeCertStatus(v: string | null): CertStatus {
  return v === 'active' || v === 'activating' ? v : 'none';
}

/**
 * Reads the e-invoicing settings for an organization and resolves them into a
 * ready-to-use config. App-level MATIAS credentials come from env; per-tenant
 * fiscal data comes from `app_settings`. Empty strings are normalized to null so
 * `configured` is honest about what is actually set.
 */
export async function loadEInvoiceConfig(
  organizationId: string,
): Promise<EInvoiceConfig> {
  const keys = Object.values(EINV_KEYS);
  const rows = await db
    .select({ key: appSettingsSchema.key, value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, organizationId),
        inArray(appSettingsSchema.key, keys),
      ),
    );

  const map = new Map(rows.map(r => [r.key, r.value]));
  const get = (k: string): string | null => {
    const v = map.get(k);
    return v && v.trim().length > 0 ? v.trim() : null;
  };

  const matias = {
    baseUrl: Env.MATIAS_API_BASE_URL,
    email: Env.MATIAS_ACCOUNT_EMAIL ?? null,
    password: Env.MATIAS_ACCOUNT_PASSWORD ?? null,
  };

  const provider = get(EINV_KEYS.provider) ?? 'none';
  const certStatus = normalizeCertStatus(get(EINV_KEYS.certStatus));
  const emitterNit = get(EINV_KEYS.emitterNit);
  const resolutionNumber = get(EINV_KEYS.resolutionNumber);

  const configured
    = provider === 'matias'
      && !!matias.email
      && !!matias.password
      && !!emitterNit
      && !!resolutionNumber
      && certStatus === 'active';

  return {
    provider,
    matias,
    emitterNit,
    resolution: get(EINV_KEYS.resolution),
    resolutionNumber,
    prefix: get(EINV_KEYS.prefix),
    certStatus,
    autoEmit: get(EINV_KEYS.autoEmit) === '1',
    configured,
  };
}
