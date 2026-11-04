// Komunikaty ekranów logowania (błąd, potwierdzenie) na `Alert` Finory.
// Błąd ma `role='alert'` (czytnik przerywa i czyta), potwierdzenie
// `role='status'` (czyta grzecznie) — `Alert` ma domyślnie zawsze `alert`.

// React Imports
import type { ReactNode } from 'react'

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

  return (
    <Alert
      variant={isError ? 'destructive' : 'default'}
      role={isError ? 'alert' : 'status'}
      data-tone={tone}
      className={cn('px-3 py-2.5', isError ? 'border-destructive/30' : 'border-primary/30', className)}
    >
      <AlertDescription className={cn('text-sm/relaxed text-pretty', isError ? 'text-destructive' : 'text-foreground')}>
        {children}
      </AlertDescription>
    </Alert>
  )
}
