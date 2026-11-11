'use client'

// Poprawka Bartosza 21.10.2026: dzwonek 1:1 z `src/components/shared/NotificationDropdown.tsx`
// Finory (rozwijka `w-xs sm:w-122`, nagłówek „NOTIFICATIONS” z plakietką
// i ikoną ustawień, pozycja w stylu zakładki „General”).
//
// Krok 8.1 planu kompletnej aplikacji, część 2 (00188): w środku prawdziwe
// powiadomienia zamiast komunikatu „wkrótce FLO”. Decyzja D1: zmienia się tylko
// zawartość dzwonka. Nagłówek rozwijki zostaje, plakietka pokazuje liczbę
// nieprzeczytanych, czerwona kropka przy ikonie jest tylko wtedy, gdy coś jest
// nieprzeczytane. Doszły: lista ostatnich wpisów (pozycje jak w zakładce
// „General” Finory) i „Oznacz wszystkie jako przeczytane” pod listą.
// Zakładki „Inbox / General” pominięte: jedna lista wystarcza.
//
// Dane z akcji serwera: przy otwarciu panelu, przy każdym otwarciu dzwonka
// i po powrocie do karty (najwyżej raz na minutę). Błąd odczytu ma wyjście
// („Spróbuj ponownie”), a nagłówek działa dalej.

// React Imports
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactElement } from 'react'

// Next Imports
import Link from 'next/link'

// Third-party Imports
import {
  RiCalendarEventLine,
  RiChat3Line,
  RiCheckboxCircleLine,
  RiCheckDoubleLine,
  RiErrorWarningLine,
  RiFileSearchLine,
  RiHandCoinLine,
  RiInboxArchiveLine,
  RiNotification3Line,
  RiRefreshLine,
  RiSettings3Line
} from '@remixicon/react'

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
import { loadAppNotificationsAction, markAppNotificationsReadAction } from '@/app/actions/app-notifications'
import type { AppNotificationItem, AppNotificationKind } from '@/lib/app-notifications/types'
import { formatWarsawDateTime } from '@/lib/format/warsaw-date'
import { cn } from '@/lib/utils'

/** Ponowny odczyt po powrocie do karty najwyżej raz na tyle milisekund. */
const REFRESH_ON_FOCUS_MS = 60_000

const LOAD_ERROR = 'Nie udało się wczytać powiadomień. Spróbuj ponownie za chwilę.'

const KIND_ICONS: Record<AppNotificationKind, typeof RiNotification3Line> = {
  inbox_new: RiInboxArchiveLine,
  invoice_accepted: RiCheckboxCircleLine,
  invoice_rejected: RiErrorWarningLine,
  tax_deadline: RiCalendarEventLine,
  // Wątek przy koszcie (krok 6.2, część 3, 00192).
  expense_comment: RiChat3Line,
  expense_document_request: RiFileSearchLine,
  // Wpłata do faktury (krok 8.1, część 3, 00197).
  payment_received: RiHandCoinLine
}

/** „1 nowe”, „3 nowe”, „5 nowych”, „22 nowe” (polska odmiana liczebnika). */
export function newCountLabel(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (n === 1 || (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14))) return `${n} nowe`
  return `${n} nowych`
}

/**
 * Przycisk dzwonka z czerwoną kropką — jak w `Header.tsx` Finory. Propsy (i ref)
 * przechodzą do `Button`: `DropdownMenuTrigger render={…}` podpina przez nie
 * obsługę kliknięcia i `aria-haspopup` — bez tego menu się nie otwiera.
 * Kropka tylko przy nieprzeczytanych (krok 8.1, część 2).
 */
export function NotificationBellButton({
  unread = 0,
  className,
  ...props
}: ComponentProps<typeof Button> & { unread?: number }) {
  return (
    <Button
      variant='ghost'
      size='icon'
      aria-label={unread > 0 ? `Powiadomienia, nieprzeczytane: ${unread}` : 'Powiadomienia'}
      {...props}
      className={cn('relative', className)}
    >
      {/* Kropka przypięta do ikony, nie do przycisku: na ekranie dotykowym przycisk
          rośnie do 44 px, a kropka liczona od jego krawędzi odrywała się od dzwonka.
          Przesunięcie jak w Finorze (32 px pudełko, kropka top 7 / right 8 → wobec ikony 16 px). */}
      <span className='relative'>
        <RiNotification3Line aria-hidden />
        {unread > 0 ? <span className='bg-destructive absolute -top-px right-0 size-1.5 rounded-full' aria-hidden /> : null}
      </span>
    </Button>
  )
}

type BellState = {
  status: 'loading' | 'ready' | 'error'
  unread: number
  items: AppNotificationItem[]
  /** Komunikat po nieudanym oznaczeniu (stan i tak wraca z bazy). */
  markError: string | null
}

export function NotificationDropdown({
  trigger,
  defaultOpen,
  align = 'end'
}: {
  trigger?: ReactElement
  defaultOpen?: boolean
  align?: 'start' | 'center' | 'end'
}) {
  const [state, setState] = useState<BellState>({ status: 'loading', unread: 0, items: [], markError: null })
  const request = useRef(0)
  const lastLoad = useRef(0)

  const load = useCallback(async () => {
    const id = ++request.current
    lastLoad.current = Date.now()
    const result = await loadAppNotificationsAction().catch(() => ({ success: false as const, error: LOAD_ERROR }))
    // Starsza odpowiedź nie nadpisuje nowszej (dwa odczyty naraz: otwarcie i powrót do karty).
    if (id !== request.current) return
    // Komunikat o nieudanym oznaczeniu zostaje do kolejnego otwarcia dzwonka.
    setState(prev =>
      result.success
        ? { ...prev, status: 'ready', unread: result.unread, items: result.items }
        : { ...prev, status: 'error' }
    )
  }, [])

  useEffect(() => {
    void load()
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoad.current > REFRESH_ON_FOCUS_MS) void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const markAll = async () => {
    // Odczyt w toku (sprzed kliknięcia) nie przywraca nieprzeczytanych.
    request.current++
    setState(prev => ({
      ...prev,
      unread: 0,
      items: prev.items.map(item => ({ ...item, read: true })),
      markError: null
    }))
    const result = await markAppNotificationsReadAction().catch(() => null)
    if (result?.success) return
    setState(prev => ({ ...prev, markError: result?.error ?? 'Nie udało się oznaczyć powiadomień. Spróbuj ponownie za chwilę.' }))
    void load()
  }

  const openItem = (item: AppNotificationItem) => {
    if (item.read) return
    request.current++
    setState(prev => ({
      ...prev,
      unread: Math.max(0, prev.unread - 1),
      items: prev.items.map(i => (i.id === item.id ? { ...i, read: true } : i))
    }))
    // Bez czekania: przejście do obiektu idzie od razu, a stan i tak wróci z bazy przy kolejnym odczycie.
    void markAppNotificationsReadAction([item.id]).catch(() => undefined)
  }

  return (
    <DropdownMenu
      defaultOpen={defaultOpen}
      onOpenChange={open => {
        if (!open) return
        setState(prev => (prev.markError ? { ...prev, markError: null } : prev))
        void load()
      }}
    >
      <DropdownMenuTrigger render={trigger ?? <NotificationBellButton unread={state.unread} />} />
      <DropdownMenuContent className='w-xs sm:w-122' align={align}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className='flex flex-col pb-0'>
            <div className='flex items-center justify-between gap-6 pb-2.5'>
              <span className='text-muted-foreground text-sm font-normal uppercase'>Powiadomienia</span>
              <div className='flex items-center gap-3'>
                {state.unread > 0 ? (
                  // Odstępstwo od Finory (WCAG 1.4.3): text-primary na primary/10 to 4,44:1.
                  <Badge variant='secondary' className='bg-primary/10 text-accent-foreground font-normal'>
                    {newCountLabel(state.unread)}
                  </Badge>
                ) : null}
                <Link href='/settings/notifications' aria-label='Ustawienia powiadomień'>
                  <RiSettings3Line className='text-foreground size-5' aria-hidden />
                </Link>
              </div>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>

        <DropdownMenuSeparator className='mt-0 h-0.5' />

        {state.status === 'error' && state.items.length === 0 ? (
          <>
            <div className='text-muted-foreground px-2 py-6 text-center text-sm' role='status'>
              {LOAD_ERROR}
            </div>
            <DropdownMenuItem closeOnClick={false} className='justify-center px-2 py-3 text-sm' onClick={() => void load()}>
              <RiRefreshLine aria-hidden />
              <span>Spróbuj ponownie</span>
            </DropdownMenuItem>
          </>
        ) : state.status === 'loading' && state.items.length === 0 ? (
          <div className='text-muted-foreground px-2 py-6 text-center text-sm' role='status'>
            Wczytuję powiadomienia…
          </div>
        ) : state.items.length === 0 ? (
          <div className='px-2 py-6 text-center'>
            <p className='text-sm font-medium'>Nie masz jeszcze powiadomień.</p>
            <p className='text-muted-foreground mt-1 text-sm'>
              Tu zobaczysz nowe faktury zakupu z KSeF i wyniki wysyłki faktur do KSeF.
            </p>
          </div>
        ) : (
          <div className='max-h-[min(26rem,60dvh)] overflow-y-auto'>
            {state.items.map((item, index) => {
              const Icon = KIND_ICONS[item.kind]
              return (
                <div key={item.id}>
                  <DropdownMenuItem
                    className='items-start gap-3 px-2 py-3 text-base not-data-[variant=destructive]:focus:**:text-[revert-rule]'
                    render={item.link ? <Link href={item.link} prefetch={false} /> : undefined}
                    onClick={() => openItem(item)}
                  >
                    <div className='bg-muted flex size-9.5 shrink-0 items-center justify-center rounded-full'>
                      <Icon className='text-foreground size-5' aria-hidden />
                    </div>
                    <div className='flex w-full min-w-0 flex-col items-start'>
                      <span className='text-base font-medium'>{item.title}</span>
                      {item.body ? <span className='text-muted-foreground line-clamp-2 text-sm'>{item.body}</span> : null}
                      <span className='text-muted-foreground text-xs tabular-nums'>{formatWarsawDateTime(item.createdAt)}</span>
                    </div>
                    <div className='flex flex-col items-center gap-3 pt-1.5'>
                      {item.read ? null : (
                        <>
                          <div className='bg-primary size-1.5 rounded-full' aria-hidden />
                          <span className='sr-only'>Nieprzeczytane.</span>
                        </>
                      )}
                    </div>
                  </DropdownMenuItem>
                  {index < state.items.length - 1 ? <DropdownMenuSeparator /> : null}
                </div>
              )
            })}
          </div>
        )}

        {state.markError ? (
          <p className='text-destructive px-2 pt-2 text-sm' role='alert'>
            {state.markError}
          </p>
        ) : null}

        {state.unread > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem closeOnClick={false} className='justify-center px-2 py-3 text-sm' onClick={() => void markAll()}>
              <RiCheckDoubleLine aria-hidden />
              <span>Oznacz wszystkie jako przeczytane</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
