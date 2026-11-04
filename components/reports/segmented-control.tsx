'use client'

import { useId } from 'react'

import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'

/** Jedna opcja przełącznika. */
export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /** Krótszy napis poniżej `sm` (np. „Sprawdź” zamiast „Do sprawdzenia”). */
  shortLabel?: string
  /** Liczba przy etykiecie (od `sm`), np. liczba wpisów w księdze. */
  count?: number
}

/**
 * Przełącznik segmentowy Księgowości (poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości) — port `RadioGroup` z Finory
 * (`views/pages/investments/equities/performance-chart-card.tsx`): ukryty
 * radiowy `RadioGroupItem` jako `peer`, a widoczny segment to `Label` obok.
 * Grupa radiowa, nie przyciski z `aria-pressed`: czytnik słyszy „1 z 3”,
 * a strzałki przełączają opcje (nawigacja kompozytowa Base UI).
 *
 * Base UI (1.5) rysuje opcję jako `<span role="radio" aria-checked>` z atrybutem
 * `data-checked` / `data-unchecked` i ukrytym `<input type="radio">` obok —
 * także w SSR — więc `peer-data-checked:` z Finory działa bez zmian. `id`
 * z propsów trafia na ukryty `<input>`, dlatego `htmlFor` etykiety go łapie
 * i kliknięcie segmentu wybiera opcję.
 *
 * Odstępstwa od Finory: `gap-0` na etykiecie (bazowy `Label` ma `gap-2`, a licznik
 * ma własne `ml-1.5` — bez tego odstęp byłby podwójny); licznik dziedziczy kolor
 * segmentu (bez `opacity-*`, dla kontrastu); `id` z `useId` zamiast stałego
 * prefiksu, żeby dwa przełączniki na jednej stronie nie miały tych samych `id`.
 *
 * Ciemny motyw (poprawka Bartosza 21.10.2026: przeprojektowanie Księgowości):
 * w naszym `.dark` `--muted` == `--card` (Finora ma tor 0.275 na karcie 0.218),
 * więc tor `bg-muted` i pigułka `bg-card` znikały na karcie, a zaznaczenie
 * zdradzała tylko jaśniejsza czcionka. Tor dostaje `dark:bg-background` — wnęka
 * ciemniejsza od karty, jak `--ff-surface-inset` w `html.dark .ff-dashboard` —
 * a zaznaczona pigułka `dark:peer-data-checked:bg-input`, jaśniejsza od toru
 * i karty (jak aktywna zakładka w `ui/tabs.tsx`). Jasny motyw bez zmian.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  className
}: {
  value: T
  onValueChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  /** Nazwa grupy dla czytnika ekranu, np. „Rodzaj wpisu”. */
  ariaLabel: string
  className?: string
}) {
  const id = useId()

  return (
    <RadioGroup
      aria-label={ariaLabel}
      value={value}
      onValueChange={next => {
        // Base UI typuje wartość luźno — bierzemy ją z naszych opcji, bez rzutowania.
        const option = options.find(candidate => candidate.value === next)
        if (option) onValueChange(option.value)
      }}
      className={cn('bg-muted text-muted-foreground inline-flex h-9 w-full items-center gap-0 p-1 sm:w-fit dark:bg-background', className)}
    >
      {options.map(option => {
        const itemId = `${id}-${option.value}`

        return (
          <div key={option.value} className='relative h-full grow'>
            <RadioGroupItem value={option.value} id={itemId} className='peer sr-only absolute' />
            <Label
              htmlFor={itemId}
              className='peer-data-checked:bg-card peer-data-checked:text-foreground dark:peer-data-checked:bg-input peer-focus-visible:ring-ring inline-flex h-full w-full cursor-pointer items-center justify-center gap-0 px-2 py-1 text-sm font-medium whitespace-nowrap transition-all peer-focus-visible:ring-2 sm:px-4'
            >
              {option.shortLabel ? (
                <>
                  <span className='sm:hidden'>{option.shortLabel}</span>
                  <span className='max-sm:hidden'>{option.label}</span>
                </>
              ) : (
                option.label
              )}
              {option.count !== undefined ? (
                <span className='ml-1.5 tabular-nums max-sm:hidden'>{option.count}</span>
              ) : null}
            </Label>
          </div>
        )
      })}
    </RadioGroup>
  )
}
