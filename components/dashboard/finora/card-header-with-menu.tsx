'use client'

// Third-party Imports
import type { ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { RiMore2Line } from '@remixicon/react'

// Component Imports
import { Button } from '@/components/ui/button'
import { CardHeader } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

/**
 * Pozycja menu ⋯ karty (PLAN-PRAWDZIWE-DANE E7 pkt 1): link albo akcja —
 * martwych pozycji („Udostępnij”, „Aktualizuj” z szablonu) typ nie
 * dopuszcza. Same napisy, więc karty serwerowe podają je bez zmian.
 */
export type CardMenuItem = { label: string; href: string } | { label: string; akcja: 'odswiez' }

// Bez eksportu stałych: karty serwerowe dostałyby z pliku `'use client'` referencję, nie obiekt.
const defaultMenuItems: CardMenuItem[] = [{ label: 'Odśwież', akcja: 'odswiez' }]

type CardHeaderWithMenuProps = {
  title: string
  subTitle?: string
  /**
   * Zastrzeżenie, które nie mieści się w podtytule (PLAN-PRAWDZIWE-DANE Z16):
   * dymek podtytułu i tekst dla czytnika ekranu, bez nowej linii na karcie.
   */
  subTitleHint?: string
  menuItems?: CardMenuItem[]
  /**
   * Plakietka obok tytułu (D-P: „Dane przykładowe”); mieści się w wysokości
   * wiersza tytułu. Na wąskim ekranie zwęża się ona, nie tytuł — podawać
   * `<DemoBadge skracana />`.
   */
  badge?: ReactNode
  className?: string
}

/** Osobny komponent: `useRouter` działa dopiero po otwarciu menu (treść menu montuje się przy otwarciu). */
const RefreshItem = ({ label }: { label: string }) => {
  const router = useRouter()

  return <DropdownMenuItem onClick={() => router.refresh()}>{label}</DropdownMenuItem>
}

const CardHeaderWithMenu = ({
  title,
  subTitle,
  subTitleHint,
  menuItems = defaultMenuItems,
  badge,
  className
}: CardHeaderWithMenuProps) => {
  return (
    <CardHeader className={className ?? 'flex items-center justify-between'}>
      <div className='flex flex-col gap-1'>
        {badge ? (
          // Tytuł się nie zwęża — na wąskim ekranie ustępuje plakietka (`DemoBadge skracana`), nie łamie się nagłówek.
          <div className='flex items-center gap-2'>
            <span className='shrink-0 text-lg font-semibold'>{title}</span>
            {badge}
          </div>
        ) : (
          <span className='text-lg font-semibold'>{title}</span>
        )}
        {subTitle && (
          <span className='text-muted-foreground text-sm' title={subTitleHint}>
            {subTitle}
          </span>
        )}
        {subTitleHint && <span className='sr-only'>{subTitleHint}</span>}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant='ghost' size='icon' className='text-muted-foreground size-6 rounded-full' />}
        >
          <RiMore2Line />
          <span className='sr-only'>Menu</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuGroup>
            {menuItems.map((item, index) =>
              'href' in item ? (
                <DropdownMenuItem key={index} render={<Link href={item.href} />}>
                  {item.label}
                </DropdownMenuItem>
              ) : (
                <RefreshItem key={index} label={item.label} />
              )
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </CardHeader>
  )
}

export default CardHeaderWithMenu
