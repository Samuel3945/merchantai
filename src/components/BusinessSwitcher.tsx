'use client';

import type { OrganizationResource } from '@clerk/types';
import { CreateOrganization, useOrganization, useOrganizationList } from '@clerk/nextjs';
import { Building2, Check, ChevronDown, Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/utils/Helpers';

export const ORG_CHANGED_EVENT = 'pos:org-changed';

function getPlan(org: Pick<OrganizationResource, 'publicMetadata'> | null | undefined): string {
  const plan = (org?.publicMetadata as { plan?: unknown } | undefined)?.plan;
  return typeof plan === 'string' && plan.length > 0 ? plan : 'Free';
}

function OrgAvatar({ name, imageUrl, size = 'sm' }: { name: string; imageUrl?: string; size?: 'sm' | 'md' }) {
  const dim = size === 'md' ? 'size-7' : 'size-6';
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={name}
        className={cn(dim, 'shrink-0 rounded-md object-cover')}
      />
    );
  }
  return (
    <div className={cn(dim, `
      flex shrink-0 items-center justify-center rounded-md bg-muted
      text-muted-foreground
    `)}
    >
      <Building2 className="size-3.5" />
    </div>
  );
}

export function BusinessSwitcher() {
  const { isLoaded: orgLoaded, organization: activeOrg } = useOrganization();
  const { isLoaded: listLoaded, userMemberships, setActive } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    if (!showCreate) {
      return;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setShowCreate(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showCreate]);

  if (!orgLoaded || !listLoaded || !setActive) {
    return (
      <div className="inline-flex h-9 w-40 animate-pulse rounded-md bg-muted" aria-hidden />
    );
  }

  async function handleSwitch(orgId: string) {
    if (!setActive || orgId === activeOrg?.id) {
      setOpen(false);
      return;
    }
    setSwitching(orgId);
    try {
      await setActive({ organization: orgId });
      window.dispatchEvent(new Event(ORG_CHANGED_EVENT));
      // Clerk ya cambió la organización activa en la sesión (cookie), pero los
      // server components se renderizaron con la org anterior. router.refresh()
      // los vuelve a pedir con la nueva org → todo se actualiza sin F5.
      router.refresh();
    } finally {
      setSwitching(null);
      setOpen(false);
    }
  }

  const memberships = userMemberships.data ?? [];

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          className={cn(
            `
              inline-flex h-9 max-w-52 items-center gap-2 rounded-md border
              bg-background px-2 text-sm transition
              hover:bg-muted
              focus:outline-none
              focus-visible:ring-2 focus-visible:ring-ring
            `,
          )}
          aria-label="Cambiar de negocio"
        >
          <OrgAvatar
            name={activeOrg?.name ?? 'Sin negocio'}
            imageUrl={activeOrg?.imageUrl}
          />
          <span className="truncate font-medium">
            {activeOrg?.name ?? 'Selecciona negocio'}
          </span>
          <ChevronDown className="ml-auto size-4 shrink-0 opacity-60" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Tus negocios
          </DropdownMenuLabel>

          {memberships.length === 0
            ? (
                <div className="
                  px-2 py-3 text-center text-xs text-muted-foreground
                "
                >
                  Aún no tienes negocios
                </div>
              )
            : (
                memberships.map((m) => {
                  const org = m.organization;
                  const isActive = org.id === activeOrg?.id;
                  const isSwitching = switching === org.id;
                  return (
                    <DropdownMenuItem
                      key={org.id}
                      disabled={isSwitching}
                      onSelect={(e) => {
                        e.preventDefault();
                        handleSwitch(org.id);
                      }}
                      className="gap-2"
                    >
                      <OrgAvatar name={org.name} imageUrl={org.imageUrl} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{org.name}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {m.role.replace('org:', '')}
                        </div>
                      </div>
                      <Badge
                        variant="secondary"
                        className="shrink-0 text-[10px]"
                      >
                        {getPlan(org)}
                      </Badge>
                      {isActive && <Check className="ml-1 size-4 text-primary" />}
                    </DropdownMenuItem>
                  );
                })
              )}

          {userMemberships.hasNextPage && (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                userMemberships.fetchNext();
              }}
              className="justify-center text-xs text-muted-foreground"
            >
              Cargar más…
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setOpen(false);
              setShowCreate(true);
            }}
            className="gap-2 font-medium"
          >
            <Plus className="size-4" />
            Crear nuevo negocio
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {showCreate && (
        <div
          className="
            fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4
          "
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowCreate(false);
            }
          }}
        >
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              aria-label="Cerrar"
              className="
                absolute -top-2 -right-2 z-10 inline-flex size-7 items-center
                justify-center rounded-full border bg-background shadow-sm
                hover:bg-muted
              "
            >
              <X className="size-4" />
            </button>
            <CreateOrganization
              skipInvitationScreen
              afterCreateOrganizationUrl="/dashboard"
              routing="hash"
            />
          </div>
        </div>
      )}
    </>
  );
}
