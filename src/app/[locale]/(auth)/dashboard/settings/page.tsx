import { auth } from '@clerk/nextjs/server';
import { setRequestLocale } from 'next-intl/server';
import { getAppSetting } from '@/actions/app-settings';
import { listPaymentMethods } from '@/actions/payment-methods';
import { TitleBar } from '@/features/dashboard/TitleBar';
import { DELIVERY_FEE_MODE_KEY } from '@/features/delivery/settlement';
import { SettingsClient } from '@/features/settings/SettingsClient';
import {
  DELIVERY_FEE_TYPE_KEY,
  DELIVERY_FEE_VALUE_KEY,
  DELIVERY_FREE_ABOVE_KEY,
} from '@/libs/delivery-fee';
import {
  BLOCK_CLOSE_SETTING_KEY,
  DEFAULT_RESOLUTION_SETTING_KEY,
} from '@/libs/transfer-reconciliation';

const KEYS = [
  // Business
  'business_name',
  'business_phone',
  'business_address',
  'business_logo',
  'business_currency',
  'business_timezone',
  // Sale modalities (shape the product form)
  'features.sell_by_weight',
  'features.wholesale',
  'features.perishable',
  'features.digital',
  // Modules
  'modules.facturas',
  'credito-enabled',
  // AI preview gate (default OFF, flipped per-org by the operator in /platform).
  // Domicilios rides with it, so its tab is hidden until AI is on.
  'modules.ai',
  // Delivery configuration (own "Domicilios" tab, gated by modules.ai). The
  // "¿Trabaja con domicilio?" master toggle persists to modules.delivery.
  'modules.delivery',
  DELIVERY_FEE_TYPE_KEY,
  DELIVERY_FEE_VALUE_KEY,
  DELIVERY_FREE_ABOVE_KEY,
  DELIVERY_FEE_MODE_KEY,
  'delivery_require_photo',
  // E-invoicing (MATIAS/DIAN)
  'fiscal_nit',
  'fiscal_dian_resolution',
  'fiscal_einvoice_provider',
  'einvoice_matias_resolution_number',
  'einvoice_matias_prefix',
  'einvoice_cert_status',
  'einvoice_auto',
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

  const rawDeliveryFeeType = map[DELIVERY_FEE_TYPE_KEY];
  const deliveryFeeType
    = rawDeliveryFeeType === 'fixed' || rawDeliveryFeeType === 'percent'
      ? rawDeliveryFeeType
      : 'none';

  return (
    <>
      <TitleBar
        title="Ajustes"
        description="Configura tu negocio, métodos de pago, módulos y preferencias."
      />
      <SettingsClient
        initialPaymentMethods={paymentMethods}
        creditoEnabled={asBool(map['credito-enabled'], true)}
        business={{
          'business_name': map.business_name,
          'business_phone': map.business_phone,
          'business_address': map.business_address,
          'business_logo': map.business_logo,
          'business_currency': map.business_currency,
          'business_timezone': map.business_timezone,
          'features.sell_by_weight': asBool(map['features.sell_by_weight']),
          'features.wholesale': asBool(map['features.wholesale']),
          'features.perishable': asBool(map['features.perishable']),
          'features.digital': asBool(map['features.digital']),
        }}
        domicilios={{
          'modules.delivery': asBool(map['modules.delivery'], true),
          'delivery_fee_type': deliveryFeeType,
          'delivery_fee_value': map[DELIVERY_FEE_VALUE_KEY],
          'delivery_free_above': map[DELIVERY_FREE_ABOVE_KEY],
          'delivery_fee_mode':
            map[DELIVERY_FEE_MODE_KEY] === 'courier_tip'
              ? 'courier_tip'
              : 'revenue',
          'delivery_require_photo': asBool(map.delivery_require_photo, false),
        }}
        aiPreviewEnabled={asBool(map['modules.ai'], false)}
        facturasEnabled={asBool(map['modules.facturas'], false)}
        fiscal={{
          fiscal_nit: map.fiscal_nit,
          fiscal_dian_resolution: map.fiscal_dian_resolution,
          fiscal_einvoice_provider: map.fiscal_einvoice_provider,
          einvoice_matias_resolution_number: map.einvoice_matias_resolution_number,
          einvoice_matias_prefix: map.einvoice_matias_prefix,
          einvoice_cert_status: map.einvoice_cert_status,
          einvoice_auto: map.einvoice_auto,
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
