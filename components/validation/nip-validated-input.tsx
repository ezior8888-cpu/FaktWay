'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  XCircle,
} from 'lucide-react';

import { Input } from '@/components/ui/input';

import { useNipValidation } from '@/hooks/use-nip-validation';
import { cn } from '@/lib/utils';
import type { CachedValidationResult } from '@/lib/validation/cache';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onValidationComplete?: (result: CachedValidationResult | null) => void;
  placeholder?: string;
  disabled?: boolean;
  enabled?: boolean;
  className?: string;
  /** `id` pola — dla `<Label htmlFor>` (WCAG 1.3.1). */
  id?: string;
}

export function NipValidatedInput({
  value,
  onChange,
  onValidationComplete,
  placeholder = 'NIP nabywcy',
  disabled,
  enabled = true,
  className,
  id,
}: Props) {
  const validationEnabled = Boolean(enabled && !disabled);
  const { status, result, error, validate } = useNipValidation({
    enabled: validationEnabled,
  });

  const onValidationCompleteRef = useRef(onValidationComplete);
  onValidationCompleteRef.current = onValidationComplete;

  useEffect(() => {
    validate(value);
  }, [value, validate, validationEnabled]);

  useEffect(() => {
    if (status === 'success' && result) {
      onValidationCompleteRef.current?.(result);
    }
  }, [status, result]);

  let trailingIcon: ReactNode = null;
  if (status === 'validating') {
    trailingIcon = (
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    );
  } else if (status === 'success' && result) {
    if (!result.isValid) {
      trailingIcon = (
        <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
      );
    } else if (result.warning) {
      trailingIcon = (
        <AlertTriangle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
      );
    } else {
      trailingIcon = (
        <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
      );
    }
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={10}
          className={cn('h-12 pr-10 font-mono text-lg', className)}
        />
        {trailingIcon ? (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {trailingIcon}
          </div>
        ) : null}
      </div>

      {status === 'success' && result ? (
        <ValidationFeedback result={result} />
      ) : null}

      {status === 'error' && error ? (
        <div className="flex items-start gap-2 text-xs text-orange-600 dark:text-orange-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Nie udało się zweryfikować NIP-u: {error}</span>
        </div>
      ) : null}
    </div>
  );
}

// ============================================================================
// Sub: feedback po walidacji
// ============================================================================

function ValidationFeedback({ result }: { result: CachedValidationResult }) {
  if (!result.isValid) {
    return (
      <div className="flex items-start gap-2.5 rounded-2xl border border-red-500/20 bg-red-500/5 p-3 backdrop-blur-glass-sm">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
        <div className="flex-1 space-y-0.5">
          <p className="text-sm font-medium text-foreground">
            {result.vatStatus === 'inactive'
              ? 'Wykreślony z VAT'
              : 'Niezweryfikowany'}
          </p>
          {result.terminationDate ? (
            <p className="text-xs text-muted-foreground">
              Wykreślenie: {result.terminationDate}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            KSeF prawdopodobnie odrzuci tę fakturę
          </p>
        </div>
      </div>
    );
  }

  if (result.warning) {
    return (
      <div className="flex items-start gap-2.5 rounded-2xl border border-orange-500/20 bg-orange-500/5 p-3 backdrop-blur-glass-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" />
        <div className="flex-1 space-y-0.5">
          <p className="text-sm font-medium text-foreground">
            {result.legalName}
          </p>
          <p className="text-xs text-muted-foreground">{result.warning}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-green-500/20 bg-green-500/5 p-3 backdrop-blur-glass-sm">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
      <div className="flex-1 space-y-0.5">
        <p className="text-sm font-medium text-foreground">
          {result.legalName}
        </p>
        <p className="text-xs text-muted-foreground">
          {result.vatStatus === 'active'
            ? 'Czynny podatnik VAT'
            : 'Zwolniony z VAT'}
          {result.fromCache ? ' • z cache' : ''}
        </p>
      </div>
    </div>
  );
}
