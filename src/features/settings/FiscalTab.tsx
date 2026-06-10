'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { testEInvoiceConnection } from '@/actions/einvoice';
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
  { value: 'factus', label: 'Factus (DIAN)' },
] as const;

const FACTUS_ENVS = [
  { value: 'sandbox', label: 'Pruebas (sandbox)' },
  { value: 'production', label: 'Producción' },
] as const;

export type FiscalTabValues = {
  fiscal_nit: string;
  fiscal_regime: string;
  fiscal_invoice_prefix: string;
  fiscal_dian_resolution: string;
  fiscal_einvoice_provider: string;
  einvoice_factus_email: string;
  einvoice_factus_password: string;
  einvoice_factus_client_id: string;
  einvoice_factus_client_secret: string;
  einvoice_factus_env: string;
  einvoice_factus_base_url: string;
};

export function FiscalTab({ initial }: { initial: FiscalTabValues }) {
  const { save } = useSettingSave();
  const [provider, setProvider] = useState(
    initial.fiscal_einvoice_provider || 'none',
  );

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
            Conectá tu proveedor para emitir facturas electrónicas ante la DIAN.
          </p>
        </div>

        <SelectField
          id="fiscal_einvoice_provider"
          label="Proveedor"
          initial={provider}
          options={EINVOICE_PROVIDERS}
          onCommit={(v) => {
            setProvider(v);
            save('fiscal_einvoice_provider', v);
          }}
        />

        {provider === 'factus' && (
          <div className="
            grid gap-4
            md:grid-cols-2
          "
          >
            <TextField
              id="einvoice_factus_email"
              label="Email de la cuenta Factus"
              initial={initial.einvoice_factus_email}
              placeholder="empresa@correo.co"
              onCommit={v => save('einvoice_factus_email', v.trim())}
            />
            <MaskedField
              id="einvoice_factus_password"
              label="Contraseña"
              initial={initial.einvoice_factus_password}
              placeholder="Contraseña de la cuenta Factus"
              onCommit={v => save('einvoice_factus_password', v)}
            />
            <TextField
              id="einvoice_factus_client_id"
              label="Client ID"
              initial={initial.einvoice_factus_client_id}
              placeholder="client_id de la app Factus"
              onCommit={v => save('einvoice_factus_client_id', v.trim())}
            />
            <MaskedField
              id="einvoice_factus_client_secret"
              label="Client Secret"
              initial={initial.einvoice_factus_client_secret}
              placeholder="client_secret de la app Factus"
              onCommit={v => save('einvoice_factus_client_secret', v)}
            />
            <SelectField
              id="einvoice_factus_env"
              label="Entorno"
              initial={initial.einvoice_factus_env || 'sandbox'}
              options={FACTUS_ENVS}
              onCommit={v => save('einvoice_factus_env', v)}
            />
            <TextField
              id="einvoice_factus_base_url"
              label="URL base (opcional)"
              initial={initial.einvoice_factus_base_url}
              placeholder="https://api.factus.com.co"
              hint="Sólo si necesitás sobrescribir la URL por defecto del entorno."
              onCommit={v => save('einvoice_factus_base_url', v.trim())}
            />
            <div className="md:col-span-2">
              <FactusConnectionTest />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FactusConnectionTest() {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ok'; env: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' });

  const run = async () => {
    setState({ status: 'loading' });
    try {
      const result = await testEInvoiceConnection();
      if (result.ok) {
        setState({ status: 'ok', env: result.env });
      } else {
        setState({ status: 'error', message: result.message });
      }
    } catch (e) {
      setState({
        status: 'error',
        message: e instanceof Error ? e.message : 'Error de conexión',
      });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={state.status === 'loading'}
        className="
          flex h-9 items-center gap-2 rounded-md border border-input
          bg-background px-3 text-xs font-medium
          hover:bg-muted
          disabled:opacity-60
        "
      >
        {state.status === 'loading' && (
          <Loader2 className="size-3.5 animate-spin" />
        )}
        Probar conexión
      </button>
      {state.status === 'ok' && (
        <span className="
          flex items-center gap-1.5 text-xs font-medium text-emerald-600
          dark:text-emerald-400
        "
        >
          <CheckCircle2 className="size-4" />
          Conexión exitosa (
          {state.env}
          )
        </span>
      )}
      {state.status === 'error' && (
        <span className="
          flex items-center gap-1.5 text-xs font-medium text-red-600
          dark:text-red-400
        "
        >
          <XCircle className="size-4" />
          {state.message}
        </span>
      )}
    </div>
  );
}
