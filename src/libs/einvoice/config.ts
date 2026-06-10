import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { appSettingsSchema } from '@/models/Schema';

// DIAN e-invoicing configuration lives in `app_settings`, org-scoped. The fiscal
// identity (NIT, DIAN resolution) is reused from the Fiscal tab; the Factus
// credentials are dedicated keys so a second provider could coexist later.
//
// Secrets are entered by the admin in Ajustes → Fiscal and never committed.
export const EINV_KEYS = {
  provider: 'fiscal_einvoice_provider', // 'factus' | 'none'
  factusEmail: 'einvoice_factus_email',
  factusPassword: 'einvoice_factus_password',
  factusClientId: 'einvoice_factus_client_id',
  factusClientSecret: 'einvoice_factus_client_secret',
  factusEnv: 'einvoice_factus_env', // 'sandbox' | 'production'
  factusBaseUrl: 'einvoice_factus_base_url', // optional override
  emitterNit: 'fiscal_nit',
  resolution: 'fiscal_dian_resolution',
} as const;

export type FactusEnv = 'sandbox' | 'production';

export type EInvoiceConfig = {
  provider: string;
  factus: {
    email: string | null;
    password: string | null;
    clientId: string | null;
    clientSecret: string | null;
    env: FactusEnv;
    baseUrl: string;
  };
  emitterNit: string | null;
  resolution: string | null;
  /** True only when the provider is Factus AND every credential is present. */
  configured: boolean;
};

const FACTUS_PROD_URL = 'https://api.factus.com.co';
const FACTUS_SANDBOX_URL = 'https://api-sandbox.factus.com.co';

/**
 * Reads the e-invoicing settings for an organization and resolves them into a
 * ready-to-use config. Empty strings are normalized to null so `configured`
 * is honest about which credentials are actually set.
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

  const env: FactusEnv
    = get(EINV_KEYS.factusEnv) === 'production' ? 'production' : 'sandbox';
  const baseUrl
    = get(EINV_KEYS.factusBaseUrl)
      ?? (env === 'production' ? FACTUS_PROD_URL : FACTUS_SANDBOX_URL);

  const factus = {
    email: get(EINV_KEYS.factusEmail),
    password: get(EINV_KEYS.factusPassword),
    clientId: get(EINV_KEYS.factusClientId),
    clientSecret: get(EINV_KEYS.factusClientSecret),
    env,
    baseUrl,
  };

  const provider = get(EINV_KEYS.provider) ?? 'none';
  const configured
    = provider === 'factus'
      && !!factus.email
      && !!factus.password
      && !!factus.clientId
      && !!factus.clientSecret;

  return {
    provider,
    factus,
    emitterNit: get(EINV_KEYS.emitterNit),
    resolution: get(EINV_KEYS.resolution),
    configured,
  };
}
