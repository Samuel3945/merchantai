'use client';

import type { LucideIcon } from 'lucide-react';
import {
  BellIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  HandshakeIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  PackageIcon,
  PlusIcon,
  QrCodeIcon,
  RadioTowerIcon,
  ReceiptIcon,
  SearchIcon,
  SendIcon,
  ShoppingCartIcon,
  TagIcon,
  Trash2Icon,
  WalletIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/utils/Helpers';

const fieldCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

// Capabilities the agent can run per channel. Adapted to MerchantAI modules.
// The effective value is `channel.capabilities[key] ?? false`.
const CAPABILITIES: { key: string; icon: LucideIcon; title: string; sub: string }[] = [
  { key: 'products_lookup', icon: SearchIcon, title: 'Consultar productos', sub: 'Precios y disponibilidad' },
  { key: 'sales_query', icon: ReceiptIcon, title: 'Consultar ventas', sub: 'Lectura de reportes' },
  { key: 'orders', icon: ShoppingCartIcon, title: 'Tomar pedidos', sub: 'Crea ventas en POS' },
  { key: 'fiados', icon: HandshakeIcon, title: 'Gestionar fiados', sub: 'Registrar y consultar' },
  { key: 'inventory_query', icon: PackageIcon, title: 'Consultar inventario', sub: 'Stock y alertas' },
  { key: 'cash_query', icon: WalletIcon, title: 'Consultar caja', sub: 'Solo lectura' },
  { key: 'price_changes', icon: TagIcon, title: 'Cambiar precios', sub: 'Confirmación en chat' },
  { key: 'alerts', icon: BellIcon, title: 'Enviar alertas', sub: 'Stock bajo, fiados, caja' },
];

type ChannelKind = 'whatsapp' | 'telegram' | 'webchat';

const CHANNEL_META: Record<ChannelKind, {
  label: string;
  icon: LucideIcon;
  placeholder: string;
  hint: string;
  comingSoon?: boolean;
}> = {
  whatsapp: {
    label: 'WhatsApp',
    icon: MessageCircleIcon,
    placeholder: '+57 300 123 4567',
    hint: 'Número que atiende. La conexión por QR llegará cuando se integre el backend.',
  },
  telegram: {
    label: 'Telegram',
    icon: SendIcon,
    placeholder: 'Token del bot',
    hint: 'Próximamente.',
    comingSoon: true,
  },
  webchat: {
    label: 'Web chat',
    icon: MessagesSquareIcon,
    placeholder: 'Identificador interno',
    hint: 'Para integraciones futuras.',
    comingSoon: true,
  },
};

type Channel = {
  id: string;
  kind: ChannelKind;
  label: string;
  purpose: string;
  identifier: string;
  active: boolean;
  capabilities: Record<string, boolean>;
  hours: { start: string; end: string } | null;
};

// "Canales conectados" — structural UI port of the Tiendademo channels panel.
// Channels live in local state only; there is no persistence or real WhatsApp
// connection yet (that needs Evolution API + n8n, out of scope here).
export function ChannelsSection() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  function updateChannel(id: string, patch: Partial<Channel>) {
    setChannels(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)));
  }

  function removeChannel(id: string) {
    setChannels(prev => prev.filter(c => c.id !== id));
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <RadioTowerIcon className="size-5 text-brand" />
            Canales conectados (
            {channels.length}
            )
          </h2>
          <p className="text-sm text-muted-foreground">
            Conecta los canales por donde responde la IA y qué puede hacer en
            cada uno.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <PlusIcon className="size-4" />
          Nuevo canal
        </Button>
      </div>

      {channels.length === 0
        ? (
            <div className="
              rounded-md border border-dashed bg-background p-8 text-center
            "
            >
              <RadioTowerIcon className="
                mx-auto mb-2 size-8 text-muted-foreground
              "
              />
              <p className="font-medium">Sin canales conectados</p>
              <p className="mb-4 text-sm text-muted-foreground">
                Agrega un WhatsApp, Telegram u otro canal para empezar a usar el
                asistente.
              </p>
              <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
                Conectar primer canal
              </Button>
            </div>
          )
        : (
            <div className="space-y-3">
              {channels.map(c => (
                <ChannelCard
                  key={c.id}
                  channel={c}
                  onUpdate={patch => updateChannel(c.id, patch)}
                  onRemove={() => removeChannel(c.id)}
                />
              ))}
            </div>
          )}

      <CreateChannelDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreate={(data) => {
          setChannels(prev => [
            ...prev,
            {
              id: crypto.randomUUID(),
              active: true,
              capabilities: {},
              hours: null,
              ...data,
            },
          ]);
          setShowCreate(false);
        }}
      />
    </section>
  );
}

function ChannelCard({
  channel,
  onUpdate,
  onRemove,
}: {
  channel: Channel;
  onUpdate: (patch: Partial<Channel>) => void;
  onRemove: () => void;
}) {
  const meta = CHANNEL_META[channel.kind];
  const Icon = meta.icon;
  const [expanded, setExpanded] = useState(false);
  const enabledCount = CAPABILITIES.filter(c => channel.capabilities[c.key]).length;

  return (
    <div
      className={cn(
        'rounded-md border bg-background',
        !channel.active && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <div className="
          flex size-10 shrink-0 items-center justify-center rounded-md
          bg-brand-soft text-brand
        "
        >
          <Icon className="size-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{channel.label}</span>
            <span className="
              text-[10px] font-semibold tracking-wider text-muted-foreground
              uppercase
            "
            >
              {meta.label}
            </span>
            {channel.active
              ? (
                  <Badge variant="secondary" className="gap-1">Activo</Badge>
                )
              : (
                  <Badge variant="outline" className="text-muted-foreground">Inactivo</Badge>
                )}
          </div>
          {channel.purpose && (
            <p className="mt-0.5 text-xs text-brand">{channel.purpose}</p>
          )}
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {channel.identifier || '— sin identificador —'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {enabledCount}
            {' '}
            capacidades activas
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={channel.active}
            aria-label={channel.active ? 'Desactivar canal' : 'Activar canal'}
            onCheckedChange={next => onUpdate({ active: next })}
          />
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="
              rounded-md p-1.5 text-muted-foreground
              hover:bg-muted hover:text-foreground
            "
            aria-label={expanded ? 'Contraer' : 'Expandir'}
          >
            {expanded
              ? <ChevronUpIcon className="size-5" />
              : <ChevronDownIcon className="size-5" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-5 border-t p-4">
          <div className="
            grid gap-3
            sm:grid-cols-2
          "
          >
            <LocalField label="Etiqueta">
              <input
                type="text"
                value={channel.label}
                onChange={e => onUpdate({ label: e.target.value })}
                className={fieldCls}
              />
            </LocalField>
            <LocalField label="Identificador" hint={meta.hint}>
              <input
                type="text"
                value={channel.identifier}
                placeholder={meta.placeholder}
                onChange={e => onUpdate({ identifier: e.target.value })}
                className={fieldCls}
              />
            </LocalField>
          </div>

          <LocalField
            label="Propósito de este canal"
            hint='Ej: "Atención clientes", "Confirmación pedidos", "Alertas admin"'
          >
            <input
              type="text"
              value={channel.purpose}
              onChange={e => onUpdate({ purpose: e.target.value })}
              className={fieldCls}
            />
          </LocalField>

          {channel.kind === 'whatsapp'
            ? <WhatsAppConnectPlaceholder />
            : (
                <div className="
                  flex items-center gap-2 rounded-md border border-amber-500/30
                  bg-amber-500/10 p-3 text-xs font-medium text-amber-600
                  dark:text-amber-400
                "
                >
                  <QrCodeIcon className="size-4 shrink-0" />
                  Próximamente — la integración con
                  {' '}
                  {meta.label}
                  {' '}
                  llegará en una siguiente versión.
                </div>
              )}

          <div>
            <p className="
              mb-1 text-xs font-semibold tracking-wider text-muted-foreground
              uppercase
            "
            >
              Capacidades de este canal
            </p>
            <p className="mb-3 text-xs text-muted-foreground">
              Activa qué puede hacer la IA cuando recibe mensajes por este canal.
            </p>
            <div className="
              grid gap-2
              sm:grid-cols-2
            "
            >
              {CAPABILITIES.map((c) => {
                const on = channel.capabilities[c.key] === true;
                const CapIcon = c.icon;
                return (
                  <div
                    key={c.key}
                    className={cn(
                      'flex items-center gap-3 rounded-md border p-2.5',
                      on ? 'border-brand/30 bg-brand-soft/40' : 'bg-background',
                    )}
                  >
                    <CapIcon
                      className={cn(
                        'size-5 shrink-0',
                        on ? 'text-brand' : 'text-muted-foreground',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold">{c.title}</p>
                      <p className="text-[10px] text-muted-foreground">{c.sub}</p>
                    </div>
                    <Switch
                      checked={on}
                      aria-label={c.title}
                      onCheckedChange={next =>
                        onUpdate({ capabilities: { ...channel.capabilities, [c.key]: next } })}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <p className="
              mb-1 text-xs font-semibold tracking-wider text-muted-foreground
              uppercase
            "
            >
              Horario activo de este canal
            </p>
            <p className="mb-3 text-xs text-muted-foreground">
              Fuera de este rango la IA no responde por este canal. Déjalo vacío
              para responder 24/7.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <LocalField label="Inicio">
                <input
                  type="time"
                  value={channel.hours?.start ?? ''}
                  onChange={(e) => {
                    const start = e.target.value;
                    onUpdate({
                      hours: start
                        ? { start, end: channel.hours?.end ?? '22:00' }
                        : null,
                    });
                  }}
                  className={fieldCls}
                />
              </LocalField>
              <LocalField label="Fin">
                <input
                  type="time"
                  value={channel.hours?.end ?? ''}
                  onChange={(e) => {
                    const end = e.target.value;
                    onUpdate({
                      hours: end
                        ? { start: channel.hours?.start ?? '06:00', end }
                        : null,
                    });
                  }}
                  className={fieldCls}
                />
              </LocalField>
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="
                text-destructive
                hover:text-destructive
              "
              onClick={onRemove}
            >
              <Trash2Icon className="size-4" />
              Eliminar canal
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function WhatsAppConnectPlaceholder() {
  return (
    <div className="
      space-y-3 rounded-md border border-brand/20 bg-brand-soft/40 p-3
    "
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="
            flex items-center gap-1 text-xs font-semibold tracking-wider
            text-brand uppercase
          "
          >
            <QrCodeIcon className="size-3.5" />
            Conexión de WhatsApp
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            El número se vinculará por QR vía Evolution API. Las credenciales
            vivirán en el servidor.
          </p>
        </div>
        <Badge variant="outline" className="text-muted-foreground">Próximamente</Badge>
      </div>
      <Button
        size="sm"
        disabled
        className="
          w-full
          sm:w-auto
        "
      >
        <QrCodeIcon className="size-4" />
        Conectar WhatsApp
      </Button>
    </div>
  );
}

function CreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (data: Pick<Channel, 'kind' | 'label' | 'purpose' | 'identifier'>) => void;
}) {
  const [kind, setKind] = useState<ChannelKind>('whatsapp');
  const [label, setLabel] = useState('');
  const [purpose, setPurpose] = useState('');
  const [identifier, setIdentifier] = useState('');
  const meta = CHANNEL_META[kind];

  function reset() {
    setKind('whatsapp');
    setLabel('');
    setPurpose('');
    setIdentifier('');
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo canal</DialogTitle>
          <DialogDescription>
            Elige el tipo de canal y cómo lo identificas.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="
              mb-2 text-xs font-semibold tracking-wider text-muted-foreground
              uppercase
            "
            >
              Tipo de canal
            </p>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(CHANNEL_META) as ChannelKind[]).map((k) => {
                const m = CHANNEL_META[k];
                const KindIcon = m.icon;
                const disabled = !!m.comingSoon;
                const selected = kind === k && !disabled;
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={disabled}
                    onClick={() => !disabled && setKind(k)}
                    title={disabled ? 'Próximamente' : m.label}
                    className={cn(
                      `
                        relative rounded-md border-2 p-3 text-left
                        transition-colors
                      `,
                      selected
                        ? 'border-brand bg-brand-soft/40'
                        : `
                          border-border
                          hover:border-muted-foreground/40
                        `,
                      disabled && `
                        cursor-not-allowed opacity-50
                        hover:border-border
                      `,
                    )}
                  >
                    <KindIcon
                      className={cn('size-5', selected
                        ? 'text-brand'
                        : `text-muted-foreground`)}
                    />
                    <span
                      className={cn(
                        'mt-1 block text-xs font-semibold',
                        selected ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {m.label}
                    </span>
                    {disabled && (
                      <span className="
                        absolute top-1 right-1 rounded-full bg-amber-500/20
                        px-1.5 py-0.5 text-[8px] font-bold tracking-wider
                        text-amber-600 uppercase
                        dark:text-amber-400
                      "
                      >
                        Pronto
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <LocalField
            label="Etiqueta"
            hint="Cómo lo identificas (ej. 'WhatsApp principal')"
          >
            <input
              type="text"
              value={label}
              placeholder="WhatsApp principal"
              onChange={e => setLabel(e.target.value)}
              className={fieldCls}
            />
          </LocalField>

          <LocalField label="Propósito" hint="Qué hace este canal (libre)">
            <input
              type="text"
              value={purpose}
              placeholder="Atención clientes / Confirmación pedidos / Alertas admin"
              onChange={e => setPurpose(e.target.value)}
              className={fieldCls}
            />
          </LocalField>

          <LocalField label="Identificador" hint={meta.hint}>
            <input
              type="text"
              value={identifier}
              placeholder={meta.placeholder}
              onChange={e => setIdentifier(e.target.value)}
              className={fieldCls}
            />
          </LocalField>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!label.trim()}
            onClick={() => {
              onCreate({
                kind,
                label: label.trim(),
                purpose: purpose.trim(),
                identifier: identifier.trim(),
              });
              reset();
            }}
          >
            Conectar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LocalField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
