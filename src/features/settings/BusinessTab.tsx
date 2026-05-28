'use client';

import { useRef, useState } from 'react';
import { SelectField, TextField } from './fields';
import { useSettingSave } from './useSettingSave';
import { useSettingsToast } from './useSettingsToast';

const CURRENCY_OPTIONS = [
  { value: 'COP', label: 'Peso colombiano (COP)' },
  { value: 'USD', label: 'Dólar (USD)' },
  { value: 'MXN', label: 'Peso mexicano (MXN)' },
  { value: 'PEN', label: 'Sol peruano (PEN)' },
  { value: 'CLP', label: 'Peso chileno (CLP)' },
  { value: 'ARS', label: 'Peso argentino (ARS)' },
] as const;

const TIMEZONE_OPTIONS = [
  { value: 'America/Bogota', label: 'Bogotá (UTC-5)' },
  { value: 'America/Mexico_City', label: 'Ciudad de México (UTC-6)' },
  { value: 'America/Lima', label: 'Lima (UTC-5)' },
  { value: 'America/Santiago', label: 'Santiago (UTC-4)' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires (UTC-3)' },
] as const;

export type BusinessTabValues = {
  business_name: string;
  business_phone: string;
  business_address: string;
  business_logo: string;
  business_currency: string;
  business_timezone: string;
};

export function BusinessTab({ initial }: { initial: BusinessTabValues }) {
  const { save } = useSettingSave();
  const toast = useSettingsToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [logoUrl, setLogoUrl] = useState(initial.business_logo);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload/logo', {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Upload failed (${res.status})`);
      }
      const data = (await res.json()) as { url: string };
      setLogoUrl(data.url);
      await save('business_logo', data.url);
    } catch (e) {
      toast.show(
        e instanceof Error ? e.message : 'No se pudo subir el logo',
        'error',
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleRemoveLogo = async () => {
    setLogoUrl('');
    await save('business_logo', '');
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Datos del negocio</h2>
        <p className="text-sm text-muted-foreground">
          Aparecen en tickets, facturas y comunicaciones con clientes.
        </p>
      </div>

      <div className="
        grid gap-4
        md:grid-cols-2
      "
      >
        <TextField
          id="business_name"
          label="Nombre del negocio"
          initial={initial.business_name}
          placeholder="Tienda Doña Marta"
          onCommit={v => save('business_name', v.trim())}
        />
        <TextField
          id="business_phone"
          label="Teléfono"
          type="tel"
          initial={initial.business_phone}
          placeholder="3001234567"
          onCommit={v => save('business_phone', v.trim())}
        />
        <div className="md:col-span-2">
          <TextField
            id="business_address"
            label="Dirección"
            initial={initial.business_address}
            placeholder="Calle 10 #20-30, Medellín"
            onCommit={v => save('business_address', v.trim())}
          />
        </div>
        <SelectField
          id="business_currency"
          label="Moneda"
          initial={initial.business_currency || 'COP'}
          options={CURRENCY_OPTIONS}
          onCommit={v => save('business_currency', v)}
        />
        <SelectField
          id="business_timezone"
          label="Zona horaria"
          initial={initial.business_timezone || 'America/Bogota'}
          options={TIMEZONE_OPTIONS}
          onCommit={v => save('business_timezone', v)}
        />
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">
          Logo del negocio
        </div>
        <div className="
          flex flex-col items-start gap-3
          sm:flex-row sm:items-center
        "
        >
          <div className="
            flex size-20 items-center justify-center overflow-hidden rounded-md
            border border-border bg-muted
          "
          >
            {logoUrl
              ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoUrl}
                    alt="Logo"
                    className="size-full object-contain"
                  />
                )
              : (
                  <span className="text-xs text-muted-foreground">Sin logo</span>
                )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            className="hidden"
            onChange={e => handleFile(e.target.files?.[0])}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="
              h-9 rounded-md border border-input bg-background px-3 text-sm
              font-medium
              hover:bg-muted
              disabled:opacity-50
            "
          >
            {uploading ? 'Subiendo…' : 'Subir logo'}
          </button>
          {logoUrl && (
            <button
              type="button"
              disabled={uploading}
              onClick={handleRemoveLogo}
              className="
                h-9 rounded-md border border-input bg-background px-3 text-sm
                text-destructive
                hover:bg-muted
                disabled:opacity-50
              "
            >
              Quitar
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          PNG, JPG, WEBP o SVG. Máx 2 MB.
        </p>
      </div>
    </div>
  );
}
