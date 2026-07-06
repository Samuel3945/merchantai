'use client';

import type { CajaConfig, CajasOverview } from '@/actions/cajas';
import { Bike, Check, Monitor, Plus, Split, Users, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import {
  archiveCourierCaja,
  assignDeviceToCaja,
  createCourierCaja,
  listCajas,
  splitDeviceToOwnCaja,
} from '@/actions/cajas';
import { Button } from '@/components/ui/button';

const cop = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function CajasManager({ initial }: { initial: CajasOverview }) {
  const [data, setData] = useState<CajasOverview>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Caja en la que estás eligiendo "con qué POS compartir".
  const [sharingInto, setSharingInto] = useState<string | null>(null);
  const [newCourierId, setNewCourierId] = useState('');

  const registerCajas = data.cajas.filter(c => c.type === 'register');
  const courierCajas = data.cajas.filter(c => c.type === 'courier');

  const refresh = () => {
    start(async () => {
      try {
        setData(await listCajas());
      } catch {
        setError('No se pudo recargar');
      }
    });
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      try {
        const r = await fn();
        if (!r.ok) {
          setError(r.error ?? 'No se pudo completar');
          return;
        }
        setSharingInto(null);
        setNewCourierId('');
        setData(await listCajas());
      } catch {
        setError('Ocurrió un error');
      }
    });
  };

  // Dispositivos que podrían MOVERSE a otra caja (los de las demás cajas).
  const devicesElsewhere = (cajaId: string) =>
    registerCajas
      .filter(c => c.id !== cajaId)
      .flatMap(c => c.devices.map(d => ({ ...d, fromCaja: c.name })));

  return (
    <section className="space-y-4">
      <div>
        <div className="text-lg font-semibold">Cajas del negocio</div>
        <p className="text-sm text-muted-foreground">
          Cada caja es una bolsa de dinero. Un punto de venta tiene su caja; si
          dos comparten la misma, es una caja compartida. Los domiciliarios
          llevan la suya.
        </p>
      </div>

      {error && (
        <div className="
          rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5
          text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      <div className="
        grid gap-3
        sm:grid-cols-2
      "
      >
        {registerCajas.map(caja => (
          <RegisterCajaCard
            key={caja.id}
            caja={caja}
            pending={pending}
            sharing={sharingInto === caja.id}
            movableDevices={devicesElsewhere(caja.id)}
            onStartShare={() => {
              setSharingInto(caja.id);
              setError(null);
            }}
            onCancelShare={() => setSharingInto(null)}
            onPick={deviceId => run(() => assignDeviceToCaja(deviceId, caja.id))}
            onSplit={deviceId => run(() => splitDeviceToOwnCaja(deviceId))}
          />
        ))}
      </div>

      {(courierCajas.length > 0 || data.couriersWithoutCaja.length > 0) && (
        <div className="space-y-2">
          <div className="text-sm font-semibold text-muted-foreground">
            Cajas de domiciliarios
          </div>
          <div className="
            grid gap-3
            sm:grid-cols-2
          "
          >
            {courierCajas.map(caja => (
              <div
                key={caja.id}
                className="
                  flex items-center justify-between gap-3 rounded-xl border
                  bg-background p-4
                "
              >
                <div className="flex items-center gap-2">
                  <span className="
                    grid size-8 place-items-center rounded-lg bg-amber-50
                    text-amber-600
                  "
                  >
                    <Bike className="size-4" />
                  </span>
                  <div>
                    <div className="text-sm font-semibold">{caja.name}</div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      Lleva
                      {' '}
                      {cop.format(caja.courierBalance ?? 0)}
                    </div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => archiveCourierCaja(caja.id))}
                >
                  Archivar
                </Button>
              </div>
            ))}
          </div>

          {data.couriersWithoutCaja.length > 0 && (
            <div className="
              flex flex-wrap items-center gap-2 rounded-xl border border-dashed
              bg-muted/30 p-3
            "
            >
              <Plus className="size-4 text-muted-foreground" />
              <span className="text-sm">Crear caja de domiciliario:</span>
              <select
                value={newCourierId}
                onChange={e => setNewCourierId(e.target.value)}
                disabled={pending}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">Elegir…</option>
                {data.couriersWithoutCaja.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={pending || !newCourierId}
                onClick={() => run(() => createCourierCaja(newCourierId))}
              >
                Crear
              </Button>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        className="text-xs text-muted-foreground underline"
      >
        Actualizar
      </button>
    </section>
  );
}

function RegisterCajaCard({
  caja,
  pending,
  sharing,
  movableDevices,
  onStartShare,
  onCancelShare,
  onPick,
  onSplit,
}: {
  caja: CajaConfig;
  pending: boolean;
  sharing: boolean;
  movableDevices: { id: string; deviceName: string; fromCaja: string }[];
  onStartShare: () => void;
  onCancelShare: () => void;
  onPick: (deviceId: string) => void;
  onSplit: (deviceId: string) => void;
}) {
  return (
    <div className="rounded-xl border bg-background p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{caja.name}</div>
          <span className={`
            mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs
            font-medium
            ${caja.isShared
      ? 'bg-sky-50 text-sky-700'
      : 'bg-violet-50 text-violet-700'}
          `}
          >
            {caja.isShared
              ? (
                  <>
                    <Users className="size-3" />
                    {' '}
                    Compartida ·
                    {' '}
                    {caja.devices.length}
                    {' '}
                    pantallas
                  </>
                )
              : (
                  <>
                    <Monitor className="size-3" />
                    {' '}
                    Individual
                  </>
                )}
          </span>
        </div>
      </div>

      <ul className="mt-3 flex flex-col gap-1">
        {caja.devices.map(d => (
          <li
            key={d.id}
            className="
              flex items-center justify-between gap-2 rounded-lg bg-muted/40
              px-2.5 py-1.5 text-sm
            "
          >
            <span className="flex items-center gap-1.5 truncate">
              <Monitor className="size-3.5 text-muted-foreground" />
              {d.deviceName}
            </span>
            {caja.devices.length > 1 && (
              <button
                type="button"
                disabled={pending}
                onClick={() => onSplit(d.id)}
                className="
                  inline-flex items-center gap-1 text-xs text-muted-foreground
                  hover:text-foreground
                "
                title="Sacar a su propia caja"
              >
                <Split className="size-3" />
                Separar
              </button>
            )}
          </li>
        ))}
        {caja.devices.length === 0 && (
          <li className="text-xs text-muted-foreground">Sin dispositivos</li>
        )}
      </ul>

      {sharing
        ? (
            <div className="mt-3 space-y-1.5 rounded-lg border bg-muted/30 p-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">Traer un POS a esta caja</span>
                <button
                  type="button"
                  onClick={onCancelShare}
                  className="text-muted-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              {movableDevices.length === 0
                ? <div className="text-xs text-muted-foreground">No hay otros POS para compartir.</div>
                : movableDevices.map(d => (
                    <button
                      key={d.id}
                      type="button"
                      disabled={pending}
                      onClick={() => onPick(d.id)}
                      className="
                        flex w-full items-center justify-between rounded-md
                        border bg-background px-2 py-1.5 text-sm
                        hover:border-sky-400
                      "
                    >
                      <span className="flex items-center gap-1.5">
                        <Monitor className="size-3.5 text-muted-foreground" />
                        {d.deviceName}
                      </span>
                      <span className="
                        flex items-center gap-1 text-xs text-sky-600
                      "
                      >
                        <Check className="size-3" />
                        {' '}
                        Compartir
                      </span>
                    </button>
                  ))}
            </div>
          )
        : (
            <button
              type="button"
              disabled={pending}
              onClick={onStartShare}
              className="
                mt-3 inline-flex items-center gap-1 text-xs font-medium
                text-sky-600
                hover:text-sky-700
              "
            >
              <Plus className="size-3.5" />
              Compartir con otro POS
            </button>
          )}
    </div>
  );
}
