// Kopia 1:1 z finora-src/src/views/pages/money-management/monthly-analytics/subscriptions-card.tsx (Analizy, decyzja Bartosza 21.10.2026): zmienione tylko teksty (z propsów), kwoty (zł, pl-PL), daty (DD.MM.RRRR), importy i źródło danych. Odstępstwa: Server Component (bez stanu); zawsze gałąź „bez logo” z ikoną z danych (logotypów kontrahentów nie mamy, `next/image` odpada); druga linia „Zwykle ok. N. dnia miesiąca” zamiast „Renews <data>”, a w tej samej linii po „ · ” link „Zrób fakturę cykliczną” (N1/E9) — w linii, żeby wiersz nie urósł; poprawka 21.10.2026 po pomiarze: cała linia (~273 px) zawijała link do trzeciej linii poniżej ~1220 px okna (karta 448,8 zamiast 367,2 px i rozciągnięty kalendarz obok), więc wiersz z akcją ma drugą linię jako jeden rząd flex — link nieściśliwy, typowy dzień ucięty wielokropkiem, a w kolumnie węższej niż 15rem (zapytanie kontenera) schowany wzrokowo (`sr-only` — czytnik go słyszy) i dopisany do `title` nazwy; link zawsze podkreślony (WCAG 1.4.1 — sam odcień `text-primary` na szarym tekście ma kontrast ~1,05:1, a podkreślenie pod myszą nie działa na dotyku); wiersz bez akcji ma drugą linię dokładnie jak Finora; prawa kolumna: średnia kwota i „Średnio / mies.” (bez `capitalize`, tekst już ma wielką literę); długa nazwa ucięta z pełną w `title` (`min-w-0`, `truncate`), prawa kolumna `shrink-0`, kwota `tabular-nums`; pusty stan (`FinoraEmpty`, `py-6` — Finora go nie ma, bo jej lista zawsze jest pełna).

// Next Imports
import Link from 'next/link'

// Type Imports
import type { FinoraEmptyState, SubscriptionItem } from './types'

// Component Imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import FinoraEmpty from './finora-empty'

// Util Imports
import { formatZl } from './format'

type SubscriptionsCardProps = {
  title: string
  description: string
  data: SubscriptionItem[]
  empty: FinoraEmptyState
  className?: string
}

const SubscriptionsCard = ({ title, description, data, empty, className }: SubscriptionsCardProps) => {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        {data.length === 0 ? (
          <FinoraEmpty {...empty} pad='py-6' />
        ) : (
          data.map(subscription => (
            <div key={subscription.id} className='flex items-center gap-4'>
              <div className='bg-muted flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full'>
                <subscription.icon className='text-foreground size-5' />
              </div>
              {/* `@container`: szerokość kolumny tekstu decyduje, czy typowy dzień mieści się obok linku. */}
              <div className='@container min-w-0 flex-1'>
                <p
                  className='truncate text-sm font-medium'
                  title={subscription.action ? `${subscription.name} · ${subscription.renewsLabel}` : subscription.name}
                >
                  {subscription.name}
                </p>
                {subscription.action ? (
                  <p className='text-muted-foreground flex min-w-0 text-xs'>
                    <span className='truncate @max-[15rem]:sr-only'>{subscription.renewsLabel}</span>
                    <span className='shrink-0 whitespace-pre @max-[15rem]:hidden' aria-hidden='true'>
                      {' · '}
                    </span>
                    <Link
                      href={subscription.action.href}
                      aria-label={subscription.action.ariaLabel}
                      className='text-primary decoration-primary/50 hover:decoration-primary shrink-0 font-medium whitespace-nowrap underline underline-offset-4'
                    >
                      {subscription.action.label}
                    </Link>
                  </p>
                ) : (
                  <p className='text-muted-foreground text-xs'>{subscription.renewsLabel}</p>
                )}
              </div>
              <div className='shrink-0 text-right'>
                <p className='text-sm font-medium tabular-nums'>{formatZl(subscription.amount)}</p>
                <p className='text-muted-foreground text-xs'>{subscription.billingCycle}</p>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

export default SubscriptionsCard
