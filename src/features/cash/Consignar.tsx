'use client';

import type { TreasuryAccountRow } from '@/libs/treasury';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { consignarDesde } from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cashInputCls } from './cash-ui';

// Move cash from a vault (caja_fuerte) to a bank account.
// Calls the 2B treasury_movements path (consignarDesde) so the write is
// visible to getTreasuryPosition after the 2C ledger cutover.
export function Consignar(props: {
  vaultAccountId: string;
  bankAccounts: TreasuryAccountRow[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [bankAccountId, setBankAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (props.bankAccounts.length === 0) {
    return null;
  }

  const bankOptions = props.bankAccounts.map(a => ({
    value: a.id,
    label: a.name,
  }));

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await consignarDesde(props.vaultAccountId, bankAccountId, amount);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setOpen(false);
        setBankAccountId('');
        setAmount('');
        router.refresh();
      } catch {
        setError('Ocurrió un error inesperado. Volvé a intentar.');
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="
          mt-2 text-xs font-medium text-primary
          hover:underline
        "
      >
        Consignar a banco
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <Select
        value={bankAccountId}
        onValueChange={setBankAccountId}
        options={bankOptions}
        placeholder="¿A qué banco?"
      />
      <input
        className={cashInputCls}
        type="number"
        inputMode="decimal"
        min="0"
        placeholder="Monto"
        value={amount}
        onChange={e => setAmount(e.target.value)}
      />
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || bankAccountId === '' || amount === ''}
          onClick={submit}
        >
          Consignar
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}
