'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';

export function NoCreditsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="w-full max-w-md rounded-xl bg-background p-6 shadow-lg">
        <div className="text-lg font-semibold">Sin créditos disponibles</div>
        <div className="mt-2 text-sm text-muted-foreground">
          Has agotado los créditos de este agente para el periodo actual.
          Compra un paquete extra (top-up) o mejora tu plan para obtener más.
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Button asChild>
            <Link href="/dashboard/plans">
              Ir a Planes
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
