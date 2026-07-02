'use client';

import type { BusinessTabValues } from './BusinessTab';
import type { DomiciliosTabValues } from './DomiciliosTab';
import type { FiscalTabValues } from './FiscalTab';
import type { ModulesTabValues } from './ModulesTab';
import type { ReturnsTabValues } from './ReturnsTab';
import type { TransferSecurityTabValues } from './TransferSecurityTab';
import type { PaymentMethodRow } from '@/actions/payment-methods';
import { useState } from 'react';
import { AuditTab } from './AuditTab';
import { BusinessTab } from './BusinessTab';
import { DomiciliosTab } from './DomiciliosTab';
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
  { key: 'returns', label: 'Devoluciones' },
];

// The Facturación tab only exists when the operator enabled e-invoicing for the
// org (platform gate). Inserted right after Módulos (or after Domicilios, if
// present) to keep the order familiar.
const FISCAL_TAB: Tab = { key: 'fiscal', label: 'Facturación' };

// Domicilios rides with the AI preview (operator-gated in /platform), same
// gate as the "Domicilios" module toggle in Módulos. Inserted right after
// Módulos to keep the fee config next to where the module lives.
const DOMICILIOS_TAB: Tab = { key: 'domicilios', label: 'Domicilios' };

const TRANSFER_SECURITY_TAB: Tab = { key: 'transfer-security', label: 'Transferencias' };
const AUDIT_TAB: Tab = { key: 'audit', label: 'Auditoría' };

export type SettingsClientProps = {
  initialPaymentMethods: PaymentMethodRow[];
  creditoEnabled: boolean;
  business: BusinessTabValues;
  modules: ModulesTabValues;
  domicilios: DomiciliosTabValues;
  fiscal: FiscalTabValues;
  returns: ReturnsTabValues;
  transferSecurity: TransferSecurityTabValues;
  isAdmin: boolean;
  // When AI preview is off the Domicilios module does not exist for this org,
  // so its toggle is hidden from the Módulos tab and the Domicilios tab itself
  // is hidden.
  aiPreviewEnabled: boolean;
  // E-invoicing is operator-gated: the Facturación tab is hidden until enabled.
  facturasEnabled: boolean;
};

export function SettingsClient({
  initialPaymentMethods,
  creditoEnabled,
  business,
  modules,
  domicilios,
  fiscal,
  returns: returnsValues,
  transferSecurity,
  isAdmin,
  aiPreviewEnabled,
  facturasEnabled,
}: SettingsClientProps) {
  const baseTabs: Tab[] = [...BASE_TABS];
  let insertAfterKey = 'modules';
  if (aiPreviewEnabled) {
    const afterModules = baseTabs.findIndex(t => t.key === insertAfterKey) + 1;
    baseTabs.splice(afterModules, 0, DOMICILIOS_TAB);
    insertAfterKey = 'domicilios';
  }
  if (facturasEnabled) {
    const afterModules = baseTabs.findIndex(t => t.key === insertAfterKey) + 1;
    baseTabs.splice(afterModules, 0, FISCAL_TAB);
  }
  const tabs = isAdmin
    ? [...baseTabs, TRANSFER_SECURITY_TAB, AUDIT_TAB]
    : baseTabs;
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
            creditoEnabled={creditoEnabled}
          />
        )}
        {activeTab === 'modules' && (
          <ModulesTab
            initial={modules}
            aiPreviewEnabled={aiPreviewEnabled}
          />
        )}
        {activeTab === 'domicilios' && <DomiciliosTab initial={domicilios} />}
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
