// Komunikaty ekranów logowania (błąd, potwierdzenie) na `Alert` Finory.
// Błąd ma `role='alert'` (czytnik przerywa i czyta), potwierdzenie
// `role='status'` (czyta grzecznie) — `Alert` ma domyślnie zawsze `alert`.

'use client'

// A-19 (WCAG 3.3.1, 4.1.3): błąd przychodzi z serwerem razem ze stroną, więc
// czytniki nie zawsze ogłaszają alert obecny od pierwszego renderu. Dlatego
// blok błędu dostaje fokus po wyświetleniu (`tabIndex={-1}`, bez wpływu na
// kolejność tabulatora i wygląd).

// React Imports
import { useEffect, useRef, type ReactNode } from 'react'

// Component Imports
import { Alert, AlertDescription } from '@/components/ui/alert'

// Util Imports
import { cn } from '@/lib/utils'

export function AuthMessage({
  tone,
  children,
  className
}: {
  tone: 'error' | 'success'
  children: ReactNode
  className?: string
}) {
  const isError = tone === 'error'
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isError) ref.current?.focus({ preventScroll: true })
  }, [isError])

  return (
    <Alert
      variant={isError ? 'destructive' : 'default'}
      ref={ref}
      tabIndex={isError ? -1 : undefined}
      role={isError ? 'alert' : 'status'}
      data-tone={tone}
      className={cn('px-3 py-2.5 focus:outline-none', isError ? 'border-destructive/30' : 'border-primary/30', className)}
    >
      <AlertDescription className={cn('text-sm/relaxed text-pretty', isError ? 'text-destructive' : 'text-foreground')}>
        {children}
      </AlertDescription>
    </Alert>
  )
}
