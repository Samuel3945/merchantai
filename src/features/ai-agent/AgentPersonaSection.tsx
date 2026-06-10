'use client';

import { BrainIcon, InfoIcon } from 'lucide-react';
import { useState } from 'react';
import { TextAreaField, TextField } from '@/features/settings/fields';

// "Personalidad base" — the agent's identity (name + tone). Mirrors the
// Tiendademo config panel. UI-only for now: state is local and nothing is
// persisted yet, since the agent backend (channels, n8n) does not exist in
// MerchantAI. Capabilities and schedules live per channel (see ChannelsSection).
export function AgentPersonaSection() {
  const [name, setName] = useState('Gerente IA');
  const [persona, setPersona] = useState('');

  return (
    <section className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <BrainIcon className="size-5 text-brand" />
          Personalidad base
        </h2>
        <p className="text-sm text-muted-foreground">
          Define quién es tu agente y cómo se comunica. Cada canal decide luego
          qué puede hacer y en qué horario.
        </p>
      </div>

      <div className="space-y-4 rounded-md border bg-background p-4">
        <TextField
          id="agent-name"
          label="Nombre del agente"
          initial={name}
          onCommit={setName}
        />

        <TextAreaField
          id="agent-persona"
          label="Tono y estilo de comunicación"
          initial={persona}
          rows={4}
          placeholder="Ej: Eres el asistente de un minimarket. Responde claro, breve y cercano, en español neutro."
          hint="Cómo debe expresarse — formal, cercano, técnico, breve…"
          onCommit={setPersona}
        />

        <div className="
          flex items-start gap-3 rounded-md border border-brand/20
          bg-brand-soft/40 p-3
        "
        >
          <InfoIcon className="mt-0.5 size-4 shrink-0 text-brand" />
          <div className="text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              Capacidades y horarios viven por canal
            </p>
            <p>
              Cada canal (WhatsApp, Telegram…) decide qué puede hacer la IA y en
              qué horario. Configúralo abajo en “Canales conectados”.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
