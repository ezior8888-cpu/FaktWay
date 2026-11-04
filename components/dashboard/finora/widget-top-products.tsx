// React Imports
import type { ReactElement } from 'react'

// Component Imports
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import CardHeaderWithMenu, { type CardMenuItem } from './card-header-with-menu'

// Util Imports
import { formatPlPercentChange } from '@/lib/format/pl'
import { cn } from '@/lib/utils'

/** Pusty drugi wiersz zostaje wierszem (twarda spacja), żeby pozycja miała tę samą wysokość. */
const EMPTY_LINE = ' '

type Props = {
  salesTitle: string
  salesMenu?: CardMenuItem[]
  productsBySalesData: {
    icon: ReactElement
    productName: string
    productBrand: string
    sales: string
    salesTitle?: string
    iconClassName?: string
  }[]
  /** Tekst w miejscu pustej listy (PLAN-PRAWDZIWE-DANE E5: pusty stan karty). */
  salesEmpty?: string | null
  volumeTitle: string
  volumeMenu?: CardMenuItem[]
  productsByVolumeData: {
    icon: ReactElement
    productName: string
    productBrand: string
    volume: string
    volumeTitle?: string
    /** Zmiana w procentach; `null` → „nowy” (brak sprzedaży w poprzednim okresie). */
    changePercentage: number | null
    iconClassName?: string
  }[]
  volumeEmpty?: string | null
  className?: string
}

const TopProductsCard = ({
  salesTitle,
  salesMenu,
  productsBySalesData,
  salesEmpty,
  volumeTitle,
  volumeMenu,
  productsByVolumeData,
  volumeEmpty,
  className
}: Props) => {
  return (
    <Card className={cn('gap-x-2 gap-y-6 lg:flex-row', className)}>
      {/* Products by sales card */}
      <div className='flex flex-1 flex-col gap-9'>
        <CardHeaderWithMenu title={salesTitle} menuItems={salesMenu} />
        <CardContent className='flex flex-1 flex-col justify-between gap-4'>
          {productsBySalesData.length === 0 && salesEmpty ? (
            <span className='text-muted-foreground text-sm'>{salesEmpty}</span>
          ) : null}
          {productsBySalesData.map((product, index) => (
            <div key={index} className='flex items-center justify-between gap-2'>
              <div className='flex min-w-0 items-center justify-between gap-3'>
                <Avatar className='size-9 after:border-0'>
                  <AvatarFallback
                    className={cn('bg-primary/10 text-primary shrink-0 [&>svg]:size-4.5', product.iconClassName)}
                  >
                    {product.icon}
                  </AvatarFallback>
                </Avatar>
                <div className='flex min-w-0 flex-col'>
                  <span className='truncate text-base' title={product.productName}>
                    {product.productName}
                  </span>
                  <span className='text-muted-foreground truncate text-sm' title={product.productBrand || undefined}>
                    {product.productBrand || EMPTY_LINE}
                  </span>
                </div>
              </div>
              <span className='shrink-0 text-sm' title={product.salesTitle}>
                {product.sales}
              </span>
            </div>
          ))}
        </CardContent>
      </div>
      <div className='flex max-lg:px-6'>
        <Separator orientation='vertical' className='hidden lg:block' />
        <Separator className='block lg:hidden' />
      </div>
      {/* Products by volume card */}
      <div className='flex flex-1 flex-col gap-9'>
        <CardHeaderWithMenu title={volumeTitle} menuItems={volumeMenu} />
        <CardContent className='flex flex-1 flex-col justify-between gap-4'>
          {productsByVolumeData.length === 0 && volumeEmpty ? (
            <span className='text-muted-foreground text-sm'>{volumeEmpty}</span>
          ) : null}
          {productsByVolumeData.map((product, index) => (
            <div key={index} className='flex items-center justify-between gap-2'>
              <div className='flex min-w-0 items-center justify-between gap-3'>
                <Avatar className='size-9 after:border-0'>
                  <AvatarFallback
                    className={cn('bg-primary/10 text-primary shrink-0 [&>svg]:size-4.5', product.iconClassName)}
                  >
                    {product.icon}
                  </AvatarFallback>
                </Avatar>
                <div className='flex min-w-0 flex-col'>
                  <span className='truncate text-base' title={product.productName}>
                    {product.productName}
                  </span>
                  <span className='text-muted-foreground truncate text-sm' title={product.productBrand || undefined}>
                    {product.productBrand || EMPTY_LINE}
                  </span>
                </div>
              </div>
              <div className='flex shrink-0 items-center justify-between gap-3 text-sm'>
                <span className='text-sm' title={product.volumeTitle}>
                  {product.volume}
                </span>
                {/*
                  Odstępstwo od Finory (WCAG 1.4.3): tekst `accent-foreground`, nie `primary` —
                  `text-primary` na `bg-primary/10` ma 4,44:1 (jasny), na `dark:bg-primary/25`
                  3,76:1 (ciemny); `accent-foreground` daje 9,00 i 6,76:1.
                */}
                <Badge className='bg-primary/10 dark:bg-primary/25 text-accent-foreground h-6 px-3 py-1'>
                  {product.changePercentage === null ? 'nowy' : formatPlPercentChange(product.changePercentage)}
                </Badge>
              </div>
            </div>
          ))}
        </CardContent>
      </div>
    </Card>
  )
}

export default TopProductsCard
