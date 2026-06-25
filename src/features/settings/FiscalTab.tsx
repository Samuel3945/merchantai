'use client';

import { CheckCircle2, FileX2, Loader2, ReceiptText, XCircle } from 'lucide-react';
import { useState } from 'react';
import { testEInvoiceConnection } from '@/actions/einvoice';
import { cn } from '@/utils/Helpers';
import { SelectField, TextField, ToggleRow } from './fields';
import { useSettingSave } from './useSettingSave';

const EINVOICE_PROVIDERS = [
  {
    value: 'none',
    label: 'Sin facturación electrónica',
    description: 'Las ventas no emiten factura ante la DIAN.',
    icon: FileX2,
  },
  {
    value: 'matias',
    label: 'MATIAS (DIAN)',
    description: 'Emite facturas y documentos POS electrónicos ante la DIAN.',
    icon: ReceiptText,
  },
] as const;

const CERT_STATUSES = [
  { value: 'none', label: 'Sin certificado' },
  { value: 'activating', label: 'Activándose' },
  { value: 'active', label: 'Activo' },
] as const;

export type FiscalTabValues = {
  fiscal_nit: string;
  fiscal_dian_resolution: string;
  fiscal_einvoice_provider: string;
  einvoice_matias_resolution_number: string;
  einvoice_matias_prefix: string;
  einvoice_cert_status: string;
  einvoice_auto: string;
};

export function FiscalTab({ initial }: { initial: FiscalTabValues }) {
  const { save } = useSettingSave();
  const [provider, setProvider] = useState(
    initial.fiscal_einvoice_provider || 'none',
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Facturación electrónica</h2>
        <p className="text-sm text-muted-foreground">
          Emití facturas y documentos POS electrónicos ante la DIAN con MATIAS.
        </p>
      </div>

      {/* Provider chooser — two cards, not a bare dropdown */}
      <div className="
        grid gap-3
        sm:grid-cols-2
      "
      >
        {EINVOICE_PROVIDERS.map((opt) => {
          const Icon = opt.icon;
          const selected = provider === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                setProvider(opt.value);
                save('fiscal_einvoice_provider', opt.value);
              }}
              className={cn(
                `
                  flex items-start gap-3 rounded-lg border p-4 text-left
                  transition-colors
                `,
                selected
                  ? 'border-primary bg-primary/5'
                  : `
                    border-input bg-background
                    hover:bg-accent/40
                  `,
              )}
            >
              <span className={cn(
                `
                  flex size-9 shrink-0 items-center justify-center rounded-md
                  border
                `,
                selected
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'text-muted-foreground',
              )}
              >
                <Icon className="size-5" />
              </span>
              <span>
                <span className={cn(
                  'block text-sm font-semibold',
                  selected && 'text-primary',
                )}
                >
                  {opt.label}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {opt.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {provider === 'matias' && (
        <div className="space-y-4 rounded-md border border-border p-4">
          <div>
            <h3 className="text-sm font-semibold">Datos del emisor (este negocio)</h3>
            <p className="text-xs text-muted-foreground">
              El NIT, la resolución de numeración y el certificado con los que este
              negocio emite ante la DIAN. La cuenta MATIAS es compartida y la
              configura el equipo de la plataforma.
            </p>
          </div>

          <div className="
            grid gap-4
            md:grid-cols-2
          "
          >
            <TextField
              id="fiscal_nit"
              label="NIT del emisor"
              initial={initial.fiscal_nit}
              placeholder="900123456-7"
              onCommit={v => save('fiscal_nit', v.trim())}
            />
            <TextField
              id="fiscal_dian_resolution"
              label="Resolución DIAN (descripción)"
              initial={initial.fiscal_dian_resolution}
              placeholder="Resolución 187..."
              onCommit={v => save('fiscal_dian_resolution', v.trim())}
            />
            <TextField
              id="einvoice_matias_resolution_number"
              label="Número de resolución"
              initial={initial.einvoice_matias_resolution_number}
              placeholder="18764074347312"
              hint="El número de la resolución de numeración asignada por la DIAN."
              onCommit={v =>
                save('einvoice_matias_resolution_number', v.trim())}
            />
            <TextField
              id="einvoice_matias_prefix"
              label="Prefijo"
              initial={initial.einvoice_matias_prefix}
              placeholder="FEV"
              onCommit={v => save('einvoice_matias_prefix', v.trim())}
            />
            <SelectField
              id="einvoice_cert_status"
              label="Estado del certificado"
              initial={
                (initial.einvoice_cert_status || 'none') as
                  'none' | 'activating' | 'active'
              }
              options={CERT_STATUSES}
              hint="En sandbox MATIAS genera un certificado de prueba automáticamente; ponelo en «Activo» para poder emitir."
              onCommit={v => save('einvoice_cert_status', v)}
            />
          </div>

          <ToggleRow
            label="Facturación automática"
            description="Cada venta emite su documento electrónico sola. Si está apagado, emitís manualmente desde Facturas."
            initial={initial.einvoice_auto === '1'}
            onCommit={v => save('einvoice_auto', v ? '1' : '0')}
          />

          <MatiasConnectionTest />
        </div>
      )}
    </div>
  );
}

function MatiasConnectionTest() {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ok'; baseUrl: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' });

  const run = async () => {
    setState({ status: 'loading' });
    try {
      const result = await testEInvoiceConnection();
      if (result.ok) {
        setState({ status: 'ok', baseUrl: result.baseUrl });
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
          Conexión exitosa con el sandbox
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
