'use client';

import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtMoney } from './format';

// Brand palette (teal/green/terracotta/amber/blue) — shared with the dashboard.
const CHART_COLORS = [
  '#0F766E',
  '#15803D',
  '#C2410C',
  '#B45309',
  '#1D4ED8',
  '#0891B2',
  '#65A30D',
  '#D97706',
];

const compactFmt = new Intl.NumberFormat('es-CO', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

type Row = Record<string, unknown>;

export function ChartCard({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`
      rounded-lg border bg-background p-4 shadow-xs
      ${className ?? ''}
    `}
    >
      <div className="mb-1 text-sm font-semibold">{title}</div>
      {description && (
        <p className="mb-3 text-xs text-muted-foreground">{description}</p>
      )}
      {!description && <div className="mb-3" />}
      {children}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="
      flex h-64 items-center justify-center text-sm text-muted-foreground
    "
    >
      {message}
    </div>
  );
}

/** Trend over time. Area for a single money series, lines for multiple. */
export function TrendChart({
  data,
  xKey,
  series,
  money = true,
  height = 288,
  empty = 'Sin datos en el período',
}: {
  data: Row[];
  xKey: string;
  series: { key: string; name: string; color?: string }[];
  money?: boolean;
  height?: number;
  empty?: string;
}) {
  if (data.length === 0) {
    return <EmptyState message={empty} />;
  }
  const fmt = money
    ? (v: number) => fmtMoney(v)
    : (v: number) => String(v);

  if (series.length === 1) {
    const only = series[0]!;
    const color = only.color ?? CHART_COLORS[0]!;
    return (
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id={`fill-${only.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.25} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis dataKey={xKey} fontSize={12} />
            <YAxis fontSize={12} tickFormatter={v => compactFmt.format(Number(v))} />
            <Tooltip formatter={value => [fmt(Number(value)), only.name]} />
            <Area
              type="monotone"
              dataKey={only.key}
              name={only.name}
              stroke={color}
              strokeWidth={2}
              fill={`url(#fill-${only.key})`}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis dataKey={xKey} fontSize={12} />
          <YAxis fontSize={12} tickFormatter={v => compactFmt.format(Number(v))} />
          <Tooltip formatter={(value, name) => [fmt(Number(value)), String(name)]} />
          <Legend />
          {series.map((sgroup, i) => (
            <Line
              key={sgroup.key}
              type="monotone"
              dataKey={sgroup.key}
              name={sgroup.name}
              stroke={sgroup.color ?? CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal ranking bars — best for named categories/products. */
export function RankBars({
  data,
  labelKey,
  valueKey,
  name,
  money = true,
  color = CHART_COLORS[0],
  height = 288,
  empty = 'Sin datos en el período',
}: {
  data: Row[];
  labelKey: string;
  valueKey: string;
  name: string;
  money?: boolean;
  color?: string;
  height?: number;
  empty?: string;
}) {
  if (data.length === 0) {
    return <EmptyState message={empty} />;
  }
  const fmt = money ? (v: number) => fmtMoney(v) : (v: number) => String(v);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis type="number" fontSize={11} tickFormatter={v => compactFmt.format(Number(v))} />
          <YAxis type="category" dataKey={labelKey} width={130} fontSize={11} />
          <Tooltip formatter={value => [fmt(Number(value)), name]} />
          <Bar dataKey={valueKey} fill={color} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Vertical bars — best for time buckets (hour, weekday, aging). */
export function ColumnBars({
  data,
  labelKey,
  valueKey,
  name,
  money = true,
  color = CHART_COLORS[0],
  height = 288,
  empty = 'Sin datos en el período',
}: {
  data: Row[];
  labelKey: string;
  valueKey: string;
  name: string;
  money?: boolean;
  color?: string;
  height?: number;
  empty?: string;
}) {
  if (data.length === 0) {
    return <EmptyState message={empty} />;
  }
  const fmt = money ? (v: number) => fmtMoney(v) : (v: number) => String(v);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis dataKey={labelKey} fontSize={11} />
          <YAxis fontSize={11} tickFormatter={v => compactFmt.format(Number(v))} />
          <Tooltip formatter={value => [fmt(Number(value)), name]} />
          <Bar dataKey={valueKey} fill={color} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Composition donut — keep to ≤6 meaningful slices. */
export function DonutChart({
  data,
  nameKey,
  valueKey,
  money = true,
  colors = CHART_COLORS,
  height = 288,
  empty = 'Sin datos en el período',
}: {
  data: Row[];
  nameKey: string;
  valueKey: string;
  money?: boolean;
  colors?: string[];
  height?: number;
  empty?: string;
}) {
  if (data.length === 0) {
    return <EmptyState message={empty} />;
  }
  const fmt = money ? (v: number) => fmtMoney(v) : (v: number) => String(v);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey={valueKey}
            nameKey={nameKey}
            cx="50%"
            cy="50%"
            innerRadius={55}
            outerRadius={90}
            paddingAngle={2}
          >
            {data.map((_, i) => (
              <Cell key={`cell-${i}`} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip formatter={value => fmt(Number(value))} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Compact stat tile for the header strip of a detail report. */
export function StatTile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'good' | 'warn' | 'danger';
  hint?: string;
}) {
  const toneClass
    = tone === 'good'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : tone === 'danger'
          ? 'text-red-600'
          : '';
  return (
    <div className="rounded-lg border bg-background p-4 shadow-xs">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`
        mt-1 font-display text-2xl font-medium tabular-nums
        ${toneClass}
      `}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
