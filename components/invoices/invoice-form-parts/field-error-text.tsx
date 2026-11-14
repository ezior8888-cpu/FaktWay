import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

import { errorTextClass } from './constants';

/**
 * Błąd pola faktury powiązany z polem (audyt dostępności 11.2026, A-01).
 *
 * `id` komunikatu daje `errorIdFor(idPola)`; pole dostaje `aria-invalid`
 * i `aria-describedby` z tym samym id (`fieldErrorProps`), a `role="alert"`
 * sprawia, że czytnik ekranu ogłasza komunikat, gdy się pojawi. Wygląd
 * zostaje jak w dotychczasowego akapitu z klasą `errorTextClass`.
 */
export const errorIdFor = (fieldId: string) => `${fieldId}-error`;

/** Atrybuty pola z błędem: `aria-invalid` i `aria-describedby` na komunikat. */
export function fieldErrorProps(fieldId: string, hasError: boolean) {
  return hasError
    ? ({ 'aria-invalid': true, 'aria-describedby': errorIdFor(fieldId) } as const)
    : {};
}

export function FieldErrorText({
  fieldId,
  className,
  icon = true,
  iconClassName,
  children,
}: {
  fieldId: string;
  className?: string;
  /** Ikona ostrzeżenia (ozdobna, `aria-hidden`); korekta ma tekst bez ikony. */
  icon?: boolean;
  /** Dodatkowe klasy ikony, gdy dotychczasowy akapit je miał (np. `shrink-0` w kartach pozycji). */
  iconClassName?: string;
  children: ReactNode;
}) {
  return (
    <p id={errorIdFor(fieldId)} role="alert" className={cn(errorTextClass, className)}>
      {icon ? <AlertCircle aria-hidden="true" className={cn('h-3 w-3', iconClassName)} /> : null}
      {children}
    </p>
  );
}
