'use client';

import type { OrgStatus, PlatformOrgRow } from '@/actions/platform-orgs';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Link } from '@/libs/I18nNavigation';

const copFmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const STATUS_LABEL: Record<OrgStatus, string> = {
  none: '—',
  trial: 'Prueba',
  vip: 'VIP',
  at_risk: 'En riesgo',
  churned: 'Perdido',
};

function StatusBadge({ status }: { status: OrgStatus }) {
  if (status === 'none') {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const variant
    = status === 'at_risk' || status === 'churned' ? 'destructive' : 'secondary';
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

function formatDate(iso: string | null): string {
  if (!iso) {
    return 'Sin ventas';
  }
  return new Date(iso).toLocaleDateString('es-CO', {
    day: '2-digit',
    month: 'short',
  });
}

export function BusinessesDirectoryClient(props: { orgs: PlatformOrgRow[] }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return props.orgs;
    }
    return props.orgs.filter(
      org =>
        org.name.toLowerCase().includes(q)
        || org.planSlug.toLowerCase().includes(q)
        || org.groupName?.toLowerCase().includes(q)
        || org.tags.some(t => t.toLowerCase().includes(q))
        || STATUS_LABEL[org.status].toLowerCase().includes(q),
    );
  }, [props.orgs, query]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Negocios</h1>
          <p className="text-sm text-muted-foreground">
            {props.orgs.length}
            {' '}
            negocios en la plataforma.
          </p>
        </div>
        <input
          type="search"
          placeholder="Buscar por nombre, plan, tag…"
          className="
            w-64 rounded-md border bg-background px-3 py-2 text-sm outline-none
            focus:ring-2 focus:ring-ring
          "
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-3 font-medium">Negocio</th>
              <th className="px-4 py-3 font-medium">Plan</th>
              <th className="px-4 py-3 font-medium">Estado</th>
              <th className="px-4 py-3 text-right font-medium">Ventas 30d</th>
              <th className="px-4 py-3 text-right font-medium">
                Facturación 30d
              </th>
              <th className="px-4 py-3 font-medium">Última venta</th>
              <th className="px-4 py-3 text-right font-medium">Cajeros</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(org => (
              <tr
                key={org.organizationId}
                className="
                  border-b
                  last:border-0
                "
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/platform/businesses/${org.organizationId}`}
                    className="
                      font-medium
                      hover:underline
                    "
                  >
                    {org.name}
                  </Link>
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {org.groupName && (
                      <span className="text-xs text-muted-foreground">
                        {org.groupName}
                      </span>
                    )}
                    {org.tags.map(tag => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3">{org.planName}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={org.status} />
                </td>
                <td className="px-4 py-3 text-right">{org.sales30d}</td>
                <td className="px-4 py-3 text-right">
                  {copFmt.format(org.revenue30d)}
                </td>
                <td className="px-4 py-3">{formatDate(org.lastSaleAt)}</td>
                <td className="px-4 py-3 text-right">{org.activeCashiers}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  Ningún negocio coincide con la búsqueda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
