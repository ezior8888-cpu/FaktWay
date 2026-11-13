'use client';

import { useEffect, useRef, type MouseEvent } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

import type { ValidationIssue } from './validation-issues';

/** Toast błędu zostaje dłużej niż domyślne 4 s (WCAG 2.2.1). */
export const ERROR_TOAST_MS = 10000;

/** Stan bloku:`nonce` rośnie przy każdym nieudanym zapisie, żeby fokus wracał na blok. */
export interface FormErrorState {
  nonce: number;
  issues: ValidationIssue[];
  /** Błąd zapisu albo wysyłki zwrócony przez serwer (np. odmowa KSeF). */
  saveError: string | null;
}

/**
 * Stały blok błędów nad akcjami formularza faktury (audyt dostępności 11.2026,
 * A-05). Toast znika po kilku sekundach; ten blok zostaje, ma `role="alert"`,
 * przejmuje fokus po nieudanym zapisie, a każdy błąd walidacji jest odnośnikiem
 * do swojego pola.
 */
export function FormErrorSummary({ state }: { state: FormErrorState | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const nonce = state?.nonce;

  useEffect(() => {
    if (nonce) ref.current?.focus();
  }, [nonce]);

  if (!state || (!state.issues.length && !state.saveError)) return null;

  const przejdzDoPola = (id: string) => (e: MouseEvent) => {
    const pole = document.getElementById(id);
    if (!pole) return;
    e.preventDefault();
    pole.focus();
    pole.scrollIntoView?.({ block: 'center' });
  };

  const tekst = (b: ValidationIssue) => (b.label ? `${b.label}: ${b.message}` : b.message);

  return (
    <Alert
      ref={ref}
      tabIndex={-1}
      variant="destructive"
      data-testid="blok-bledow-formularza"
      className="focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none"
    >
      <AlertTitle>
        {state.issues.length
          ? 'Faktury nie da się zapisać, popraw pola poniżej'
          : 'Nie udało się zapisać faktury'}
      </AlertTitle>
      <AlertDescription>
        {state.saveError ? <p>{state.saveError}</p> : null}
        {state.issues.length ? (
          <ul className="list-disc space-y-0.5 pl-4">
            {state.issues.map((b) => (
              <li key={`${b.path}:${b.message}`}>
                {b.targetId ? (
                  <a href={`#${b.targetId}`} onClick={przejdzDoPola(b.targetId)}>
                    {tekst(b)}
                  </a>
                ) : (
                  tekst(b)
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
