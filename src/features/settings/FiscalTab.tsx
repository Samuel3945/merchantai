'use client';

import { MaskedField, SelectField, TextAreaField, TextField } from './fields';
import { useSettingSave } from './useSettingSave';

const REGIME_OPTIONS = [
  { value: 'simplificado', label: 'Régimen Simplificado' },
  { value: 'comun', label: 'Régimen Común' },
  { value: 'simple', label: 'Régimen Simple de Tributación' },
  { value: 'no_responsable', label: 'No responsable de IVA' },
] as const;

const EINVOICE_PROVIDERS = [
  { value: 'none', label: 'No usar facturación electrónica' },
  { value: 'alegra', label: 'Alegra' },
  { value: 'siigo', label: 'Siigo' },
] as const;

export type FiscalTabValues = {
  fiscal_nit: string;
  fiscal_regime: string;
  fiscal_invoice_prefix: string;
  fiscal_dian_resolution: string;
  fiscal_einvoice_provider: string;
  fiscal_einvoice_token: string;
};

export function FiscalTab({ initial }: { initial: FiscalTabValues }) {
  const { save } = useSettingSave();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Información fiscal</h2>
        <p className="text-sm text-muted-foreground">
          Datos de identificación tributaria y facturación electrónica DIAN.
        </p>
      </div>

      <div className="
        grid gap-4
        md:grid-cols-2
      "
      >
        <TextField
          id="fiscal_nit"
          label="NIT / Identificación tributaria"
          initial={initial.fiscal_nit}
          placeholder="900123456-7"
          onCommit={v => save('fiscal_nit', v.trim())}
        />
        <SelectField
          id="fiscal_regime"
          label="Régimen fiscal"
          initial={initial.fiscal_regime || 'simplificado'}
          options={REGIME_OPTIONS}
          onCommit={v => save('fiscal_regime', v)}
        />
        <TextField
          id="fiscal_invoice_prefix"
          label="Prefijo de facturación"
          initial={initial.fiscal_invoice_prefix}
          placeholder="FE"
          hint="Se antepone al consecutivo (ej: FE-000123)."
          onCommit={v => save('fiscal_invoice_prefix', v.trim().toUpperCase())}
        />
        <div className="md:col-span-2">
          <TextAreaField
            id="fiscal_dian_resolution"
            label="Resolución DIAN"
            initial={initial.fiscal_dian_resolution}
            placeholder="Número, fecha, rango autorizado…"
            rows={3}
            onCommit={v => save('fiscal_dian_resolution', v.trim())}
          />
        </div>
      </div>

      <div className="space-y-4 rounded-md border border-border p-4">
        <div>
          <h3 className="text-sm font-semibold">Facturación electrónica</h3>
          <p className="text-xs text-muted-foreground">
            Integración con proveedor para envío de facturas electrónicas.
          </p>
        </div>
        <SelectField
          id="fiscal_einvoice_provider"
          label="Proveedor"
          initial={initial.fiscal_einvoice_provider || 'none'}
          options={EINVOICE_PROVIDERS}
          onCommit={v => save('fiscal_einvoice_provider', v)}
        />
        <MaskedField
          id="fiscal_einvoice_token"
          label="Token de API"
          initial={initial.fiscal_einvoice_token}
          placeholder="Pega aquí tu token"
          hint="El token se guarda cifrado; solo se muestran los primeros caracteres."
          onCommit={v => save('fiscal_einvoice_token', v)}
        />
      </div>
    </div>
  );
}
