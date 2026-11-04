'use client'

// Poprawka Bartosza 21.10.2026: dzwonek 1:1 z `src/components/shared/NotificationDropdown.tsx`
// Finory (rozwijka `w-xs sm:w-122`, nagłówek „NOTIFICATIONS” z plakietką
// i ikoną ustawień, pozycja w stylu zakładki „General”). Listy powiadomień
// jeszcze nie mamy, więc w środku jest jeden komunikat: wkrótce będzie tu FLO.
// Zakładki „Inbox / General” pominięte — przy jednym komunikacie byłyby puste.

// React Imports
import type { ComponentProps, ReactElement } from 'react'

// Next Imports
import Link from 'next/link'

// Third-party Imports
import { RiNotification3Line, RiSettings3Line, RiSparkling2Line } from '@remixicon/react'

// Component Imports
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

// Lib Imports
import { cn } from '@/lib/utils'

/**
 * Przycisk dzwonka z czerwoną kropką — jak w `Header.tsx` Finory. Propsy (i ref)
 * przechodzą do `Button`: `DropdownMenuTrigger render={…}` podpina przez nie
 * obsługę kliknięcia i `aria-haspopup` — bez tego menu się nie otwiera.
 */
export function NotificationBellButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button variant='ghost' size='icon' aria-label='Powiadomienia' {...props} className={cn('relative', className)}>
      {/* Kropka przypięta do ikony, nie do przycisku: na ekranie dotykowym przycisk
          rośnie do 44 px, a kropka liczona od jego krawędzi odrywała się od dzwonka.
          Przesunięcie jak w Finorze (32 px pudełko, kropka top 7 / right 8 → wobec ikony 16 px). */}
      <span className='relative'>
        <RiNotification3Line aria-hidden />
        <span className='bg-destructive absolute -top-px right-0 size-1.5 rounded-full' aria-hidden />
      </span>
    </Button>
  )
}

export function NotificationDropdown({
  trigger = <NotificationBellButton />,
  defaultOpen,
  align = 'end'
}: {
  trigger?: ReactElement
  defaultOpen?: boolean
  align?: 'start' | 'center' | 'end'
}) {
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent className='w-xs sm:w-122' align={align}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className='flex flex-col pb-0'>
            <div className='flex items-center justify-between gap-6 pb-2.5'>
              <span className='text-muted-foreground text-sm font-normal uppercase'>Powiadomienia</span>
              <div className='flex items-center gap-3'>
                {/* Odstępstwo od Finory (WCAG 1.4.3): text-primary na primary/10 to 4,44:1. */}
                <Badge variant='secondary' className='bg-primary/10 text-accent-foreground font-normal'>
                  1 nowe
                </Badge>
                <Link href='/settings/notifications' aria-label='Ustawienia powiadomień'>
                  <RiSettings3Line className='text-foreground size-5' aria-hidden />
                </Link>
              </div>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>

        <DropdownMenuSeparator className='mt-0 h-0.5' />

        <DropdownMenuItem className='gap-3 px-2 py-3 text-base not-data-[variant=destructive]:focus:**:text-[revert-rule]'>
          <div className='bg-muted flex size-9.5 shrink-0 items-center justify-center rounded-full'>
            <RiSparkling2Line className='text-foreground size-5' aria-hidden />
          </div>
          <div className='flex w-full flex-col items-start'>
            <span className='text-base font-medium'>Wkrótce w tym miejscu: FLO</span>
            <span className='text-muted-foreground text-sm'>
              Tu pojawią się podpowiedzi FLO — asystenta FaktWay, który pokaże, co wymaga Twojej uwagi.
            </span>
          </div>
          <div className='flex flex-col items-center gap-3'>
            <div className='bg-primary size-1.5 rounded-full' aria-hidden />
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
