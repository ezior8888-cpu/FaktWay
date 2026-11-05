'use client';

import { useEffect, useState } from 'react';

import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';

import { validateBankAccountAction } from '@/app/actions/validation';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** NIP nabywcy — gdy sprawdzamy konto względem jego Białej Listy */
  buyerNip?: string;
  /** NIP sprzedawcy — gdy sprawdzamy, czy to konto jest zgłoszone na jego BL */
  sellerNip?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

function isCompletePlBankAccount(cleaned: string): boolean {
  if (/^PL\d{26}$/i.test(cleaned)) {
    return true;
  }
  return /^\d{26}$/.test(cleaned);
}

function formatIbanDisplay(raw: string): string {
  const c = raw.replace(/\s/g, '').toUpperCase();
  if (!c) return '';
  if (/^PL/i.test(c)) {
    const rest = c.slice(2).replace(/\D/g, '');
    return `PL ${rest.replace(/(\d{2})(?=\d)/g, '$1 ').trim()}`.trim();
  }
  return c.replace(/\D/g, '').replace(/(\d{2})(?=\d)/g, '$1 ').trim();
}

export function BankAccountInput({
  value,
  onChange,
  buyerNip,
  sellerNip,
  placeholder = '00 0000 0000 0000 0000 0000 0000',
  disabled,
  className,
}: Props) {
  const [status, setStatus] = useState<
    'idle' | 'validating' | 'valid' | 'invalid'
  >('idle');
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    const cleaned = value.replace(/\s/g, '').toUpperCase();

    if (!isCompletePlBankAccount(cleaned) || (!buyerNip && !sellerNip)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset walidacji w tym samym efekcie, który startuje zapytanie do serwera
      setStatus('idle');
      setWarning(null);
      return;
    }

    const checkNip = (sellerNip ?? buyerNip ?? '')
      .replace(/[\s-]/g, '')
      .replace(/\D/g, '');
    if (checkNip.length !== 10) {
      setStatus('idle');
      setWarning(null);
      return;
    }

    setStatus('validating');
    setWarning(null);

    let cancelled = false;
    const timeout = setTimeout(async () => {
      const result = await validateBankAccountAction(checkNip, cleaned);
      if (cancelled) return;

      if (result.success) {
        if (result.isOnWhitelist) {
          setStatus('valid');
          setWarning(null);
        } else {
          setStatus('invalid');
          setWarning(
            result.warning ?? 'Konto nie jest na Białej Liście',
          );
        }
      } else {
        setStatus('idle');
        setWarning(null);
      }
    }, 1000);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [value, buyerNip, sellerNip]);

  const formatted = formatIbanDisplay(value);

  return (
    <div className={cn('space-y-2', className)}>
      <div className="relative">
        <Input
          value={formatted}
          onChange={(e) =>
            onChange(e.target.value.replace(/\s/g, '').toUpperCase())
          }
          placeholder={placeholder}
          disabled={disabled}
          className="pr-10 font-mono"
          autoComplete="off"
        />
        <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
          {status === 'validating' ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : null}
          {status === 'valid' ? (
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
          ) : null}
          {status === 'invalid' ? (
            <AlertTriangle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
          ) : null}
        </div>
      </div>

      {status === 'invalid' && warning ? (
        <div className="flex items-start gap-2.5 rounded-2xl border border-orange-500/20 bg-orange-500/5 p-3 backdrop-blur-glass-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" />
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">
              Konto nie jest zgłoszone do US
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{warning}</p>
          </div>
        </div>
      ) : null}

      {status === 'valid' ? (
        <p className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
          <CheckCircle2 className="h-3 w-3" />
          Konto zgłoszone do US (Biała Lista)
        </p>
      ) : null}
    </div>
  );
}
