import { ArrowLeft, Clock, User } from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCajaDetail } from '@/actions/cash';
import { CajaActionsHistory } from '@/features/cash/CajaActionsHistory';
import { CajaDetailTabs } from '@/features/cash/CajaDetailTabs';
import { money, relativeTime } from '@/features/cash/cash-ui';
import { CashActivityTimeline } from '@/features/cash/CashActivityTimeline';
import { CashClosuresHistory } from '@/features/cash/CashClosuresHistory';

function Field(props: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {props.icon}
        {props.label}
      </div>
      <div className="mt-1 font-display font-semibold tabular-nums">
        {props.value}
      </div>
    </div>
  );
}

export default async function CajaDetailPage(props: {
  params: Promise<{ locale: string; caja: string }>;
}) {
  const { locale, caja } = await props.params;
  setRequestLocale(locale);

  const detail = await getCajaDetail(caja);
  if (!detail) {
    notFound();
  }

  return (
    <>
      <Link
        href="/dashboard/cash"
        className="
          inline-flex items-center gap-1 text-sm text-muted-foreground
          hover:text-foreground
        "
      >
        <ArrowLeft className="size-4" />
        Volver a cajas
      </Link>

      <div className="
        mt-3 rounded-xl border border-border bg-card p-5 shadow-xs
      "
      >
        <div className="flex items-center justify-between gap-2">
          <h1 className="font-display text-2xl font-semibold">
            {detail.deviceName || 'Caja sin nombre'}
          </h1>
          <span
            className={
              detail.status === 'open'
                ? `
                  inline-flex items-center gap-1.5 rounded-full bg-success/10
                  px-2 py-0.5 text-xs font-medium text-success
                `
                : `
                  inline-flex items-center gap-1.5 rounded-full bg-muted px-2
                  py-0.5 text-xs font-medium text-muted-foreground
                `
            }
          >
            {detail.status === 'open' ? 'Activa' : 'Cerrada'}
          </span>
        </div>

        <div className="
          mt-4 grid grid-cols-2 gap-4
          sm:grid-cols-4
        "
        >
          <Field
            icon={<User className="size-3" />}
            label="Responsable"
            value={detail.responsable ?? '—'}
          />
          <Field label="Efectivo esperado" value={money(detail.expected)} />
          <Field
            icon={<Clock className="size-3" />}
            label="Última actividad"
            value={relativeTime(detail.lastActivityAt)}
          />
          <Field
            label="Movimientos"
            value={String(detail.movements.length)}
          />
        </div>
      </div>

      <div className="mt-6">
        <CajaDetailTabs
          activity={<CashActivityTimeline movements={detail.movements} />}
          closures={<CashClosuresHistory sessions={detail.closures} />}
          audit={<CajaActionsHistory actions={detail.adminActions} />}
        />
      </div>
    </>
  );
}

export const dynamic = 'force-dynamic';
