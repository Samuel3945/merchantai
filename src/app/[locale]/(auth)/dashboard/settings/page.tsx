import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { getAppSetting } from '@/actions/app-settings';
import { listPaymentMethods } from '@/actions/payment-methods';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { SettingsClient } from '@/features/settings/SettingsClient';

const KEYS = [
  // Business
  'business_name',
  'business_phone',
  'business_address',
  'business_logo',
  'business_currency',
  'business_timezone',
  'business_offering',
  // Sale modalities (shape the product form)
  'features.sell_by_weight',
  'features.wholesale',
  'features.perishable',
  // Modules
  'modules.delivery',
  'modules.employees',
  'fiado-enabled',
  // Fiscal
  'fiscal_nit',
  'fiscal_regime',
  'fiscal_invoice_prefix',
  'fiscal_dian_resolution',
  'fiscal_einvoice_provider',
  // Factus (DIAN e-invoicing) credentials
  'einvoice_factus_email',
  'einvoice_factus_password',
  'einvoice_factus_client_id',
  'einvoice_factus_client_secret',
  'einvoice_factus_env',
  'einvoice_factus_base_url',
  // Integrations
  'whatsapp_business_token',
  'whatsapp_phone_number_id',
  'wompi_public_key',
  'wompi_private_key',
  'openai_api_key',
  // Returns
  'returns_enabled',
  'returns_max_days',
  'returns_require_admin',
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
          'business_address': map.business_address,
          'business_logo': map.business_logo,
          'business_currency': map.business_currency,
          'business_timezone': map.business_timezone,
          'business_offering': map.business_offering || 'productos',
          'features.sell_by_weight': asBool(map['features.sell_by_weight']),
          'features.wholesale': asBool(map['features.wholesale']),
          'features.perishable': asBool(map['features.perishable']),
        }}
        modules={{
          'modules.delivery': asBool(map['modules.delivery']),
          'modules.employees': asBool(map['modules.employees']),
        }}
        fiscal={{
          fiscal_nit: map.fiscal_nit,
          fiscal_regime: map.fiscal_regime,
          fiscal_invoice_prefix: map.fiscal_invoice_prefix,
          fiscal_dian_resolution: map.fiscal_dian_resolution,
          fiscal_einvoice_provider: map.fiscal_einvoice_provider,
          einvoice_factus_email: map.einvoice_factus_email,
          einvoice_factus_password: map.einvoice_factus_password,
          einvoice_factus_client_id: map.einvoice_factus_client_id,
          einvoice_factus_client_secret: map.einvoice_factus_client_secret,
          einvoice_factus_env: map.einvoice_factus_env,
          einvoice_factus_base_url: map.einvoice_factus_base_url,
        }}
        integrations={{
          whatsapp_business_token: map.whatsapp_business_token,
          whatsapp_phone_number_id: map.whatsapp_phone_number_id,
          wompi_public_key: map.wompi_public_key,
          wompi_private_key: map.wompi_private_key,
          openai_api_key: map.openai_api_key,
        }}
        returns={{
          returns_enabled: asBool(map.returns_enabled, true),
          returns_max_days: map.returns_max_days,
          returns_require_admin: asBool(map.returns_require_admin),
        }}
        isAdmin={isAdmin}
      />
    </>
  );
}

export const dynamic = 'force-dynamic';
