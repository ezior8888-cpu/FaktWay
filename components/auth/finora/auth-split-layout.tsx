// Ekrany logowania, rejestracji, resetu hasła, 2FA, zaproszenia
// i onboardingu: ekran pół na pół. Po lewej formularz na białym tle, po
// prawej niebieska połowa w stylu strony głównej (od 23.10.2026; wcześniej
// czarna połowa z tłem ze znaków z szablonu Finora). Zmiany względem Finory
// (plan §5 P15), które zostają:
//  - korzeń ma `min-h-dvh` zamiast `h-dvh`, a prawa połowa `lg:sticky lg:h-dvh`:
//    nasze formularze mają komunikaty, Turnstile i dłuższe kreatory
//    (onboarding), a przy `h-dvh` + `items-center` górę zbyt wysokiej treści
//    ucina ekran bez przewijania;
//  - poniżej `lg` prawa połowa jest ukryta, więc hasło stoi nad formularzem
//    w jednym akapicie.
// Klasa `ff-dashboard` daje skalę SM presetu D2 i font panelu (§10.1) —
// tak jak w Finorze, gdzie skala siedzi na <html> także dla ekranów auth.

// React Imports
import type { ReactNode } from 'react'

// Next Imports
import Link from 'next/link'

// Component Imports
import { Reveal } from '@/components/site/motion'
import { BandGlow } from '@/components/site/ui'
import { PortalContainerProvider } from '@/components/ui/portal-container'
import { OFERTA_TEKST } from '@/lib/marketing/oferta'

import { AuthLogo } from './auth-logo'
import { AuthShowcase } from './auth-showcase'

/**
 * Pierwsze zdanie to zdanie oferty z lib/marketing/oferta.ts, to samo co na
 * stronie głównej i w cenniku (FaktWay 1.0). Drugie zostaje z dawnej strony
 * logowania, bo mówi prawdę o wysyłce.
 */
export const AUTH_SLOGAN_TITLE = OFERTA_TEKST
export const AUTH_SLOGAN_TEXT = 'Wystawiasz fakturę, my wysyłamy ją do KSeF i pilnujemy potwierdzenia.'

export function AuthSplitLayout({
  children,
  panelTitle,
  panelText
}: {
  children: ReactNode
  /** Duży nagłówek na niebieskiej połowie. */
  panelTitle: string
  /** Akapit pod nagłówkiem. */
  panelText: string
}) {
  return (
    <div className='ff-dashboard min-h-dvh bg-background text-foreground'>
      {/* Okna i menu (np. import z pliku w onboardingu) renderują się w tym
          drzewie, więc dziedziczą skalę i motyw `.ff-dashboard` — jak w panelu. */}
      <PortalContainerProvider>
        <div className='min-h-dvh lg:grid lg:grid-cols-2'>
          <main className='flex min-h-dvh items-center justify-center sm:px-6 md:px-8'>
            <Reveal onLoad className='flex w-full flex-col gap-6 p-6 sm:max-w-lg'>
              <Link href='/' className='w-fit'>
                <AuthLogo className='gap-3' />
              </Link>

              <p className='text-muted-foreground lg:hidden'>
                {AUTH_SLOGAN_TITLE} {AUTH_SLOGAN_TEXT}
              </p>

              {children}
            </Reveal>
          </main>

          {/* Panel dekoracyjny: bez nagłówka i poza drzewem dostępności (A-07),
              bo powtarza hasło widoczne nad formularzem na telefonie. */}
          <div aria-hidden='true' className='max-lg:hidden lg:sticky lg:top-0 lg:h-dvh lg:p-3'>
            <div className='relative flex h-full flex-col justify-between gap-10 overflow-hidden rounded-3xl bg-primary p-10 text-primary-foreground xl:p-14'>
              <BandGlow />

              <Reveal onLoad delay={0.1} className='relative'>
                <p className='text-4xl font-semibold tracking-tight text-balance xl:text-5xl'>{panelTitle}</p>
                <p className='mt-5 max-w-lg text-lg text-pretty text-primary-foreground'>{panelText}</p>
              </Reveal>

              <Reveal onLoad delay={0.25} className='relative mx-auto w-full max-w-md'>
                <AuthShowcase />
                <p className='mt-8 text-xl font-semibold tracking-tight text-pretty'>{AUTH_SLOGAN_TITLE}</p>
                <p className='mt-2 text-pretty text-primary-foreground'>{AUTH_SLOGAN_TEXT}</p>
              </Reveal>
            </div>
          </div>
        </div>
      </PortalContainerProvider>
    </div>
  )
}
