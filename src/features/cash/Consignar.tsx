'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { consignarABanco } from '@/actions/treasury';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cashInputCls } from './cash-ui';

// Move cash from the safe to a bank account. Lowers caja fuerte, raises the bank.
export function Consignar(props: { banks: { value: string; label: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [method, setMethod] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (props.banks.length === 0) {
    return null;
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await consignarABanco(method, amount);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setOpen(false);
        setMethod('');
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
        value={method}
        onValueChange={setMethod}
        options={props.banks}
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
          disabled={pending || method === '' || amount === ''}
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
