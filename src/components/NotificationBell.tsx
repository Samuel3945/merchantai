'use client';

import {
  AlertTriangle,
  Bell,
  Check,
  ClipboardList,
  Clock,
  PackageX,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { markAllAsRead, markAsRead } from '@/actions/notifications';
import { cn } from '@/utils/Helpers';

type NotificationKind
  = | 'cash_difference'
    | 'low_stock'
    | 'expiring_soon'
    | 'fiado_overdue'
    | 'sale_alert';

// Where each alert gets resolved. Clicking a notification takes the owner
// straight to the screen where they can act on it.
const KIND_HREF: Record<NotificationKind, string> = {
  cash_difference: '/dashboard/reports/analisis-caja',
  low_stock: '/dashboard/products',
  expiring_soon: '/dashboard/inventory',
  fiado_overdue: '/dashboard/fiados',
  sale_alert: '/dashboard/sales',
};

type NotificationSeverity = 'low' | 'mid' | 'high';

type Notification = {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
};

const POLL_INTERVAL_MS = 60_000;

const KIND_ICON: Record<NotificationKind, React.ComponentType<{ className?: string }>> = {
  cash_difference: Wallet,
  low_stock: PackageX,
  expiring_soon: Clock,
  fiado_overdue: AlertTriangle,
  sale_alert: ClipboardList,
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(1, Math.floor(diffMs / 60_000));
  if (mins < 60) {
    return `hace ${mins} min`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `hace ${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasHigh, setHasHigh] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=20', {
        cache: 'no-store',
      });
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as {
        items: Notification[];
        unreadCount: number;
      };
      setItems(data.items ?? []);
      setUnreadCount(data.unreadCount ?? 0);
      setHasHigh(
        (data.items ?? []).some(n => !n.read && n.severity === 'high'),
      );
    } catch {
      // Polling failures are silent — the next tick will retry.
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current
        && !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  async function handleMarkOne(id: string) {
    setLoading(true);
    try {
      await markAsRead(id);
      await fetchNotifications();
    } finally {
      setLoading(false);
    }
  }

  // Clicking a notification navigates to its fix screen. Close the dropdown and
  // mark it read in the background — navigation shouldn't wait on the write.
  function handleOpenNotification(n: Notification) {
    setOpen(false);
    if (!n.read) {
      void markAsRead(n.id).catch(() => {
        // Best-effort: the next poll reconciles the read state.
      });
    }
  }

  async function handleMarkAll() {
    setLoading(true);
    try {
      await markAllAsRead();
      await fetchNotifications();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Notificaciones"
        onClick={() => setOpen(prev => !prev)}
        className={cn(
          `
            relative inline-flex size-9 items-center justify-center rounded-md
            transition
            hover:bg-muted
          `,
          hasHigh && 'animate-pulse',
        )}
      >
        <Bell className="size-5" />
        {unreadCount > 0 && (
          <span
            className="
              absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center
              justify-center rounded-full bg-red-600 px-1 text-[10px]
              font-semibold text-white
            "
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="
            absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-md border
            bg-popover text-popover-foreground shadow-lg
          "
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">Notificaciones</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAll}
                disabled={loading}
                className="
                  text-xs text-primary
                  hover:underline
                  disabled:opacity-50
                "
              >
                Marcar todas como leídas
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0
              ? (
                  <div className="
                    px-3 py-6 text-center text-sm text-muted-foreground
                  "
                  >
                    No hay notificaciones
                  </div>
                )
              : (
                  items.map((n) => {
                    const Icon = KIND_ICON[n.kind] ?? Bell;
                    const href = KIND_HREF[n.kind] ?? '/dashboard';
                    return (
                      <div
                        key={n.id}
                        className={cn(
                          `
                            flex items-start gap-2 border-b px-3 py-2 text-sm
                            last:border-b-0
                          `,
                          !n.read && 'bg-muted/40',
                        )}
                      >
                        <Link
                          href={href}
                          onClick={() => handleOpenNotification(n)}
                          className="flex min-w-0 flex-1 items-start gap-2"
                        >
                          <Icon
                            className={cn(
                              'mt-0.5 size-4 shrink-0',
                              n.severity === 'high' && 'text-red-600',
                              n.severity === 'mid' && 'text-amber-600',
                              n.severity === 'low' && 'text-muted-foreground',
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="
                              flex items-center justify-between gap-2
                            "
                            >
                              <span className="truncate font-medium">{n.title}</span>
                              <span className="
                                shrink-0 text-[10px] text-muted-foreground
                              "
                              >
                                {timeAgo(n.createdAt)}
                              </span>
                            </div>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {n.message}
                            </p>
                          </div>
                        </Link>
                        {!n.read && (
                          <button
                            type="button"
                            aria-label="Marcar como leída"
                            onClick={() => handleMarkOne(n.id)}
                            disabled={loading}
                            className="
                              mt-0.5 inline-flex size-6 items-center
                              justify-center rounded-sm
                              hover:bg-muted
                              disabled:opacity-50
                            "
                          >
                            <Check className="size-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
          </div>
        </div>
      )}
    </div>
  );
}
