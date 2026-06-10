'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';

type ChartBlock = {
  type: 'bar' | 'line';
  xKey: string;
  yKey: string;
  data: Record<string, unknown>[];
};

function tryParseChart(text: string): { cleanText: string; chart: ChartBlock | null } {
  const match = text.match(/```chart[^\S\n]*\n([\s\S]*?)\n```/);
  if (!match) {
    return { cleanText: text, chart: null };
  }
  try {
    const chart = JSON.parse(match[1]!) as ChartBlock;
    if (chart.type && chart.xKey && chart.yKey && Array.isArray(chart.data)) {
      return { cleanText: text.replace(match[0], '').trim(), chart };
    }
  } catch {
    // ignore
  }
  return { cleanText: text, chart: null };
}

function MiniChart({ chart }: { chart: ChartBlock }) {
  return (
    <div className="
      mt-3 h-56 w-full rounded-lg border border-border bg-background p-3
    "
    >
      <ResponsiveContainer width="100%" height="100%">
        {chart.type === 'line'
          ? (
              <LineChart data={chart.data}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey={chart.xKey} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line dataKey={chart.yKey} stroke="hsl(var(--primary))" />
              </LineChart>
            )
          : (
              <BarChart data={chart.data}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey={chart.xKey} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey={chart.yKey} fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            )}
      </ResponsiveContainer>
    </div>
  );
}

export function ChatPanel({
  api,
  placeholder,
  onMessageComplete,
  onNoCredits,
}: {
  api: string;
  placeholder: string;
  onMessageComplete?: () => void;
  onNoCredits: () => void;
}) {
  const [inputValue, setInputValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(() => new DefaultChatTransport({ api }), [api]);

  const { messages, status, error, sendMessage, setMessages } = useChat({
    transport,
    onFinish: () => {
      onMessageComplete?.();
    },
    onError: (err) => {
      if (err.message?.includes('402') || err.message?.includes('no_credits')) {
        onNoCredits();
      }
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const isLoading = status === 'streaming' || status === 'submitted';

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading) {
      return;
    }
    sendMessage({ text: inputValue.trim() });
    setInputValue('');
  };

  return (
    <div className="
      flex h-[65vh] flex-col rounded-xl border border-border bg-background
    "
    >
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.map((m) => {
          const isUser = m.role === 'user';
          const fullText = m.parts
            ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map(p => p.text)
            .join('') ?? '';

          if (!fullText) {
            return null;
          }

          const { cleanText, chart } = tryParseChart(fullText);

          return (
            <div
              key={m.id}
              className={`
                flex
                ${isUser ? 'justify-end' : 'justify-start'}
              `}
            >
              <div
                className={`
                  max-w-[80%] rounded-xl px-4 py-3 text-sm/relaxed
                  whitespace-pre-wrap
                  ${
            isUser
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-foreground'
            }
                `}
              >
                {cleanText}
                {chart && <MiniChart chart={chart} />}
              </div>
            </div>
          );
        })}

        {isLoading && messages.at(-1)?.role === 'user' && (
          <div className="flex justify-start">
            <div className="
              animate-pulse rounded-xl bg-muted px-4 py-3 text-sm
              text-muted-foreground
            "
            >
              Pensando...
            </div>
          </div>
        )}

        {error && !error.message?.includes('402') && (
          <div className="
            rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3
            text-sm text-destructive
          "
          >
            Error:
            {' '}
            {error.message}
          </div>
        )}
      </div>

      <form
        onSubmit={onSubmit}
        className="flex gap-2 border-t border-border p-3"
      >
        <input
          type="text"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          placeholder={placeholder}
          disabled={isLoading}
          className="
            flex-1 rounded-lg border border-border bg-background px-4 py-2.5
            text-sm outline-none
            focus:border-primary
          "
        />
        <Button type="submit" disabled={isLoading || !inputValue.trim()}>
          Enviar
        </Button>
      </form>

      {messages.length > 0 && (
        <div className="flex justify-end border-t border-border px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMessages([])}
            disabled={isLoading}
          >
            Limpiar chat
          </Button>
        </div>
      )}
    </div>
  );
}
