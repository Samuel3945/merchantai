import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { getAppSetting } from '@/actions/app-settings';
import { listPaymentMethods } from '@/actions/payment-methods';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { SettingsClient } from '@/features/settings/SettingsClient';
import {
  BLOCK_CLOSE_SETTING_KEY,
  DEFAULT_RESOLUTION_SETTING_KEY,
} from '@/libs/transfer-reconciliation';

const KEYS = [
  // Business
  'business_name',
  'business_phone',
  'business_logo',
  'business_currency',
  'business_timezone',
  // Sale modalities (shape the product form)
  'features.sell_by_weight',
  'features.wholesale',
  'features.perishable',
  'features.digital',
  // Modules (all default ON)
  'modules.employees',
  'modules.delivery',
  'modules.suppliers',
  'modules.facturas',
  'fiado-enabled',
  // AI preview gate (default OFF, flipped per-org by the operator in /platform).
  // Domicilios rides with it, so its module toggle is hidden until AI is on.
  'modules.ai',
  // E-invoicing (Factus/DIAN)
  'fiscal_nit',
  'fiscal_einvoice_provider',
  'einvoice_factus_email',
  'einvoice_factus_password',
  'einvoice_factus_client_id',
  'einvoice_factus_client_secret',
  'einvoice_factus_env',
  'einvoice_factus_base_url',
  // Returns
  'returns_enabled',
  'returns_max_days',
  'returns_require_admin',
  // Transfer investigation toggles (admin-only)
  BLOCK_CLOSE_SETTING_KEY,
  DEFAULT_RESOLUTION_SETTING_KEY,
] as const;

type SettingKey = (typeof KEYS)[number];

const asBool = (v: string, fallback = false) =>
  v === 'true' ? true : v === 'false' ? false : fallback;

export default async function DashboardSettingsPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  const [{ orgRole }, paymentMethods, ...settings] = await Promise.all([
    auth(),
    listPaymentMethods(),
    ...KEYS.map(k => getAppSetting(k)),
  ]);

  const isAdmin = !orgRole || orgRole === 'org:admin';

  const map = Object.fromEntries(
    settings.map((s, i) => [KEYS[i] as SettingKey, s.value]),
  ) as Record<SettingKey, string>;

  return (
    <>
      <TitleBar
        title="Ajustes"
        description="Configura tu negocio, métodos de pago, módulos y preferencias."
      />
      <SettingsClient
        initialPaymentMethods={paymentMethods}
        fiadoEnabled={asBool(map['fiado-enabled'], true)}
        business={{
          'business_name': map.business_name,
          'business_phone': map.business_phone,
          'business_logo': map.business_logo,
          'business_currency': map.business_currency,
          'business_timezone': map.business_timezone,
          'features.sell_by_weight': asBool(map['features.sell_by_weight']),
          'features.wholesale': asBool(map['features.wholesale']),
          'features.perishable': asBool(map['features.perishable']),
          'features.digital': asBool(map['features.digital']),
        }}
        modules={{
          'modules.employees': asBool(map['modules.employees'], true),
          'modules.delivery': asBool(map['modules.delivery'], true),
          'modules.suppliers': asBool(map['modules.suppliers'], true),
          'modules.facturas': asBool(map['modules.facturas'], true),
        }}
        aiPreviewEnabled={asBool(map['modules.ai'], false)}
        fiscal={{
          fiscal_nit: map.fiscal_nit,
          fiscal_einvoice_provider: map.fiscal_einvoice_provider,
          einvoice_factus_email: map.einvoice_factus_email,
          einvoice_factus_password: map.einvoice_factus_password,
          einvoice_factus_client_id: map.einvoice_factus_client_id,
          einvoice_factus_client_secret: map.einvoice_factus_client_secret,
          einvoice_factus_env: map.einvoice_factus_env,
          einvoice_factus_base_url: map.einvoice_factus_base_url,
        }}
        returns={{
          returns_enabled: asBool(map.returns_enabled, true),
          returns_max_days: map.returns_max_days,
          returns_require_admin: asBool(map.returns_require_admin),
        }}
        transferSecurity={{
          blockCloseOnInvestigation: asBool(
            map[BLOCK_CLOSE_SETTING_KEY],
            false,
          ),
          defaultResolution:
            map[DEFAULT_RESOLUTION_SETTING_KEY] === 'direct_loss'
              ? 'direct_loss'
              : 'investigate',
        }}
        isAdmin={isAdmin}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
