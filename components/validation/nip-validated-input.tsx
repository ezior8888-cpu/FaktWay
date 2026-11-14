'use client';

import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';

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
  /** Błąd pola z formularza (np. zły format): `aria-invalid` na polu (WCAG 3.3.1). */
  invalid?: boolean;
  /** `id` elementów opisujących pole (komunikat błędu, podpowiedź), przed wynikiem sprawdzenia. */
  describedBy?: string;
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
  invalid,
  describedBy,
}: Props) {
  const wynikId = `${useId()}-wynik-nip`;
  const validationEnabled = Boolean(enabled && !disabled);
  const { status, result, error, validate } = useNipValidation({
    enabled: validationEnabled,
  });

  const onValidationCompleteRef = useRef(onValidationComplete);
  useLayoutEffect(() => {
    onValidationCompleteRef.current = onValidationComplete;
  });

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
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-muted-foreground" />
    );
  } else if (status === 'success' && result) {
    if (!result.isValid) {
      trailingIcon = (
        <XCircle aria-hidden="true" className="h-4 w-4 text-red-600 dark:text-red-400" />
      );
    } else if (result.warning) {
      trailingIcon = (
        <AlertTriangle aria-hidden="true" className="h-4 w-4 text-orange-600 dark:text-orange-400" />
      );
    } else {
      trailingIcon = (
        <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-green-600 dark:text-green-400" />
      );
    }
  }

  const wynikWidoczny =
    (status === 'success' && Boolean(result)) || (status === 'error' && Boolean(error));
  const nieaktywny = status === 'success' && result ? !result.isValid : false;
  const opisanePrzez = [describedBy, wynikWidoczny ? wynikId : undefined].filter(Boolean).join(' ');

  return (
    <div className="space-y-2">
      <div className="relative">
        <Input
          id={id}
          aria-invalid={invalid || nieaktywny ? true : undefined}
          aria-describedby={opisanePrzez || undefined}
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
        <ValidationFeedback result={result} id={wynikId} />
      ) : null}

      {status === 'error' && error ? (
        <div
          id={wynikId}
          role="alert"
          className="flex items-start gap-2 text-xs text-orange-600 dark:text-orange-400"
        >
          <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Nie udało się zweryfikować NIP-u: {error}</span>
        </div>
      ) : null}
    </div>
  );
}

// ============================================================================
// Sub: feedback po walidacji
// ============================================================================

/**
 * Wynik w tle pojawia się bez ruchu fokusu, więc ogłasza go czytnik ekranu:
 * `role="status"` dla wyniku w porządku i ostrzeżenia, `role="alert"` dla
 * podatnika wykreślonego albo niezweryfikowanego (audyt dostępności, A-06).
 */
function ValidationFeedback({ result, id }: { result: CachedValidationResult; id: string }) {
  if (!result.isValid) {
    return (
      <div
        id={id}
        role="alert"
        className="flex items-start gap-2.5 rounded-2xl border border-red-500/20 bg-red-500/5 p-3 backdrop-blur-glass-sm">
        <XCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
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
      <div
        id={id}
        role="status"
        className="flex items-start gap-2.5 rounded-2xl border border-orange-500/20 bg-orange-500/5 p-3 backdrop-blur-glass-sm">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" />
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
    <div
      id={id}
      role="status"
      className="flex items-start gap-2.5 rounded-2xl border border-green-500/20 bg-green-500/5 p-3 backdrop-blur-glass-sm">
      <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
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
