'use client'

// Poprawka Bartosza 21.10.2026: pasek górny 1:1 z `src/components/layout/Header.tsx`
// Finory. Lewa strona: zwijanie paska · separator · wyszukiwarka (⌘K). Prawa:
// dzwonek (powiadomienia, krok 8.1 planu kompletnej aplikacji) · motyw · zębatka (/settings) · profil.
// Bez panelu personalizacji szablonu (paleta kolorów) — mamy jeden preset.
// Tytuł strony, przełącznik firmy i wordmark z dawnego paska wylatują: firma
// jest w menu profilu („Moje firmy”), tytuły stron są w treści.

// React Imports
import type { ReactNode } from 'react'

// Next Imports
import Link from 'next/link'

// Third-party Imports
import { RiSettings3Line } from '@remixicon/react'

// Component Imports
import { FaktWayLogo } from '@/components/brand/faktway-logo'
import { CommandMenu, CommandMenuPhoneTrigger } from '@/components/dashboard/command-menu'
import { NotificationDropdown } from '@/components/dashboard/notification-dropdown'
import { ThemeToggle } from '@/components/dashboard/theme-toggle'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'

/**
 * Nagłówek panelu. Menu profilu przychodzi jako slot (`ReactNode`), bo dane
 * firm czyta asynchroniczny Server Component w `Suspense`, a komponent
 * kliencki nie może go zaimportować.
 *
 * Klasa `ff-shell-header` niesie tło, dolną ramkę i wcięcie ekranu
 * (`app/globals.css`); wysokość daje `py-2` jak w Finorze.
 *
 * Telefon (poniżej `sm`, poprawka Bartosza 03.11.2026): niższy pasek, przy
 * menu logo zamiast lupy, lupa po prawej, bez zębatki (Ustawienia są w menu
 * profilu i w „Więcej”). Od `sm` w górę pasek jest taki jak był.
 */
export function AppHeader({ profile }: { profile: ReactNode }) {
  return (
    <header className='ff-shell-header sticky top-0 z-40 w-full shrink-0 px-2 sm:px-6'>
      {/* Wewnętrzny kontener jak w Finorze (układ „compact”: `max-w-348`, `py-2`). */}
      <div className='relative mx-auto flex w-full max-w-348 items-center justify-between py-1 sm:py-2'>
        <div className='flex items-center gap-0.5 sm:gap-4'>
          <SidebarTrigger className='[&_svg]:size-5!' />
          <Separator orientation='vertical' className='hidden h-4! self-center! sm:block' />
          <Link href='/dashboard' aria-label='FaktWay, pulpit' className='flex items-center sm:hidden'>
            <FaktWayLogo className='h-[22px]' />
          </Link>
          <CommandMenu />
        </div>
        <div className='flex items-center sm:gap-1.5'>
          <CommandMenuPhoneTrigger />
          <NotificationDropdown />
          <ThemeToggle />
          <Button
            variant='ghost'
            size='icon'
            className='max-sm:hidden'
            render={<Link href='/settings' />}
            nativeButton={false}
            aria-label='Ustawienia'
          >
            <RiSettings3Line aria-hidden />
          </Button>
          {profile}
        </div>
      </div>
    </header>
  )
}
