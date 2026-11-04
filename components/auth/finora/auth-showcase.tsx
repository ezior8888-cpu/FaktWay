'use client'

// Karta na niebieskiej połowie ekranów logowania: jedna faktura przechodzi
// przez trzy kroki, które FaktWay robi sam (wysyłka do KSeF i UPO, jak
// w cenniku). Kroki zapalają się po kolei i scena wraca do początku.
// Faktura jest zmyślona.

// React Imports
import { useEffect, useState } from 'react'

// Third-party Imports
import { motion, useReducedMotion } from 'framer-motion'
import { Check } from 'lucide-react'

// Util Imports
import { cn } from '@/lib/utils'

const STEPS = ['Wystawiona', 'Wysłana do KSeF', 'Potwierdzenie UPO pobrane'] as const

const STEP_MS = 1100
const HOLD_MS = 2600

export function AuthShowcase() {
  const reducedMotion = useReducedMotion()
  // Ile kroków jest już zrobionych (0…3).
  const [done, setDone] = useState(0)

  useEffect(() => {
    if (reducedMotion) return
    const wait = done < STEPS.length ? STEP_MS : HOLD_MS
    const timer = setTimeout(() => setDone(current => (current < STEPS.length ? current + 1 : 0)), wait)
    return () => clearTimeout(timer)
  }, [done, reducedMotion])

  const shown = reducedMotion ? STEPS.length : done

  return (
    <div aria-hidden className='rounded-2xl bg-card p-6 text-card-foreground shadow-2xl shadow-black/25'>
      <div className='flex items-start justify-between gap-4'>
        <div>
          <p className='text-sm text-muted-foreground'>Faktura</p>
          <p className='mt-0.5 font-mono font-semibold'>FV/2026/10/014</p>
        </div>
        <p className='font-mono text-lg font-semibold'>1 230,00 zł</p>
      </div>

      <ol className='mt-6 space-y-3'>
        {STEPS.map((label, i) => {
          const complete = i < shown
          const current = i === shown
          return (
            <li key={label} className='flex items-center gap-3'>
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full ring-1 transition-colors duration-300',
                  complete ? 'bg-primary text-primary-foreground ring-primary' : 'ring-border'
                )}
              >
                {complete ? (
                  <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                    <Check className='size-4' />
                  </motion.span>
                ) : current ? (
                  <span className='size-2 animate-pulse rounded-full bg-primary' />
                ) : null}
              </span>
              <span
                className={cn(
                  'text-sm transition-colors duration-300',
                  complete ? 'font-medium text-foreground' : 'text-muted-foreground'
                )}
              >
                {label}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
