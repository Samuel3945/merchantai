'use client';

import type { BusinessTabValues } from './BusinessTab';
import type { FiscalTabValues } from './FiscalTab';
import type { ModulesTabValues } from './ModulesTab';
import type { ReturnsTabValues } from './ReturnsTab';
import type { TransferSecurityTabValues } from './TransferSecurityTab';
import type { PaymentMethodRow } from '@/actions/payment-methods';
import { useState } from 'react';
import { AuditTab } from './AuditTab';
import { BusinessTab } from './BusinessTab';
import { FiscalTab } from './FiscalTab';
import { ModulesTab } from './ModulesTab';
import { PaymentMethodsClient } from './PaymentMethodsClient';
import { ReturnsTab } from './ReturnsTab';
import { TransferSecurityTab } from './TransferSecurityTab';
import { SettingsToastProvider } from './useSettingsToast';

type Tab = {
  key: string;
  label: string;
};

const BASE_TABS: ReadonlyArray<Tab> = [
  { key: 'business', label: 'Negocio' },
  { key: 'payment-methods', label: 'Métodos de pago' },
  { key: 'modules', label: 'Módulos' },
  { key: 'fiscal', label: 'Facturación' },
  { key: 'returns', label: 'Devoluciones' },
];

const TRANSFER_SECURITY_TAB: Tab = { key: 'transfer-security', label: 'Transferencias' };
const AUDIT_TAB: Tab = { key: 'audit', label: 'Auditoría' };

export type SettingsClientProps = {
  initialPaymentMethods: PaymentMethodRow[];
  fiadoEnabled: boolean;
  business: BusinessTabValues;
  modules: ModulesTabValues;
  fiscal: FiscalTabValues;
  returns: ReturnsTabValues;
  transferSecurity: TransferSecurityTabValues;
  isAdmin: boolean;
  // When AI preview is off the Domicilios module does not exist for this org,
  // so its toggle is hidden from the Módulos tab.
  aiPreviewEnabled: boolean;
};

export function SettingsClient({
  initialPaymentMethods,
  fiadoEnabled,
  business,
  modules,
  fiscal,
  returns: returnsValues,
  transferSecurity,
  isAdmin,
  aiPreviewEnabled,
}: SettingsClientProps) {
  const tabs = isAdmin
    ? [...BASE_TABS, TRANSFER_SECURITY_TAB, AUDIT_TAB]
    : BASE_TABS;
  const [activeTab, setActiveTab] = useState<string>(tabs[0]!.key);

  return (
    <SettingsToastProvider>
      <div className="space-y-6">
        <div className="flex gap-1 overflow-x-auto border-b">
          {tabs.map(tab => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`
                -mb-px shrink-0 border-b-2 px-4 py-2 text-sm font-medium
                transition-colors
                ${
            activeTab === tab.key
              ? 'border-foreground text-foreground'
              : `
                border-transparent text-muted-foreground
                hover:text-foreground
              `
            }
              `}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'business' && <BusinessTab initial={business} />}
        {activeTab === 'payment-methods' && (
          <PaymentMethodsClient
            initialMethods={initialPaymentMethods}
            fiadoEnabled={fiadoEnabled}
          />
        )}
        {activeTab === 'modules' && (
          <ModulesTab initial={modules} aiPreviewEnabled={aiPreviewEnabled} />
        )}
        {activeTab === 'fiscal' && <FiscalTab initial={fiscal} />}
        {activeTab === 'returns' && <ReturnsTab initial={returnsValues} />}
        {activeTab === 'transfer-security' && isAdmin && (
          <TransferSecurityTab initial={transferSecurity} />
        )}
        {activeTab === 'audit' && isAdmin && <AuditTab />}
      </div>
    </SettingsToastProvider>
  );
}
