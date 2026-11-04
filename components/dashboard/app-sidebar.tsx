'use client'

// Plan Finora §4/P0 (E2): pasek boczny z `src/components/layout/Sidebar.tsx`
// szablonu. Stałe z D2: wariant `inset`, zwijanie do ikon. Pozycje menu
// z `lib/dashboard-nav-config.ts` (bez `Collapsible` — nasze menu jest płaskie).

// React Imports
import { memo, useCallback, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'

// Next Imports
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'

// Component Imports
import { FaktWayLogo, FaktWayMark } from '@/components/brand/faktway-logo'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from '@/components/ui/sidebar'

// Config Imports
import {
  dashboardNavSections,
  dashboardSettingsNavItem,
  isActiveNavPath,
  type DashboardNavItem
} from '@/lib/dashboard-nav-config'

const SIDEBAR_VARIANT = 'inset'
const SIDEBAR_COLLAPSIBLE = 'icon'

/**
 * Klasy aktywnej pozycji jak w Finorze (pigułka w kolorze `primary`). Tekst:
 * jasny `chart-3` (`primary` na własnym 10% miał 4,20:1), ciemny `primary`.
 */
const ACTIVE_ITEM_CLASS =
  'data-active:bg-primary/10! dark:data-active:bg-primary/20! data-active:text-chart-3 hover:data-active:text-chart-3 dark:data-active:text-primary dark:hover:data-active:text-primary'

function shouldHandlePrimaryInAppNav(e: ReactPointerEvent): boolean {
  return e.pointerType !== 'mouse' || (e.button === 0 && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey)
}

interface NavItemProps {
  item: DashboardNavItem
  active: boolean
  /** Bieżąca strona (nie to samo co podświetlenie oczekującego celu). */
  current: boolean
  onPrimaryDown: (href: string) => void
  onPrefetchHover: (href: string) => void
}

/**
 * Pojedyncza pozycja menu — `memo` po stricte równych propsach. Zmiana
 * `pendingHref` w rodzicu przerysowuje wyłącznie dwie pozycje (poprzednią
 * aktywną i nową), a nie całe menu.
 */
const NavItem = memo(function NavItem({ item, active, current, onPrimaryDown, onPrefetchHover }: NavItemProps) {
  const Icon = item.icon
  const prefetchable = item.prefetch !== false

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={item.label}
        isActive={active}
        aria-current={current ? 'page' : undefined}
        className={ACTIVE_ITEM_CLASS}
        render={<Link href={item.href} prefetch={prefetchable ? undefined : false} />}
        onPointerDown={e => {
          if (!shouldHandlePrimaryInAppNav(e)) return
          onPrimaryDown(item.href)
        }}
        onPointerEnter={prefetchable ? () => onPrefetchHover(item.href) : undefined}
        onFocus={prefetchable ? () => onPrefetchHover(item.href) : undefined}
      >
        <Icon aria-hidden />
        <span>{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
})

/** Kliknięty cel i adres, z którego go kliknięto. */
interface PendingNav {
  href: string
  fromPath: string
}

/**
 * Podświetlenie menu odłączone od momentu, w którym Next dokończy RSC:
 * `pointerdown` ustawia „cel” natychmiast, a kolejne szybkie kliknięcia go
 * nadpisują. Cel świeci tylko, dopóki adres się nie zmieni — każda zmiana
 * adresu (dotarcie do celu albo przekierowanie gdzie indziej) go unieważnia,
 * bez efektu zerującego stan.
 */
export function AppSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [pending, setPending] = useState<PendingNav | null>(null)
  const [seenPath, setSeenPath] = useState(pathname)

  // Każda zmiana adresu unieważnia oczekujący cel (reset w renderze, bez
  // efektu) — inaczej po A → B → Wstecz do A „fromPath” znów by pasował.
  if (seenPath !== pathname) {
    setSeenPath(pathname)
    setPending(null)
  }

  const beginNavTo = useCallback(
    (href: string) => {
      setPending(isActiveNavPath(pathname, href) ? null : { href, fromPath: pathname })
    },
    [pathname]
  )

  const armPrefetch = useCallback(
    (href: string) => {
      void router.prefetch(href)
    },
    [router]
  )

  /** Obecnie podświetlana trasa: pending wygrywa, dopóki URL nie dogoni. */
  const highlightedHref = useMemo(() => {
    if (pending !== null && pending.fromPath === pathname && !isActiveNavPath(pathname, pending.href)) {
      return pending.href
    }

    return null
  }, [pathname, pending])

  const isHrefActive = useCallback(
    (href: string) => {
      if (highlightedHref !== null) return href === highlightedHref

      return isActiveNavPath(pathname, href)
    },
    [pathname, highlightedHref]
  )

  return (
    <Sidebar variant={SIDEBAR_VARIANT} collapsible={SIDEBAR_COLLAPSIBLE}>
      <SidebarHeader className='h-(--ff-header-h) flex-row items-center px-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0'>
        {/* Rozwinięty: logo. Zwinięty do ikon: sam znak (logo nie mieści się w 3rem). */}
        <Link
          href='/dashboard'
          className='min-w-0 transition-opacity hover:opacity-80 group-data-[collapsible=icon]:hidden'
        >
          <FaktWayLogo className='h-7' />
        </Link>
        <Link
          href='/dashboard'
          className='hidden size-8 shrink-0 items-center justify-center transition-opacity group-data-[collapsible=icon]:flex hover:opacity-80'
        >
          <FaktWayMark className='size-7' />
        </Link>
      </SidebarHeader>

      <nav aria-label='Nawigacja główna' className='flex min-h-0 flex-1 flex-col'>
      <SidebarContent className='group-data-[collapsible=icon]:overflow-y-auto'>
        {dashboardNavSections.map(section => (
          <SidebarGroup key={section.title}>
            <SidebarGroupLabel className='tracking-wider uppercase'>
              {section.title}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className='gap-0.5'>
                {section.items.map(item => (
                  <NavItem
                    key={item.href}
                    item={item}
                    active={isHrefActive(item.href)}
                    current={isActiveNavPath(pathname, item.href)}
                    onPrimaryDown={beginNavTo}
                    onPrefetchHover={armPrefetch}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <NavItem
            item={dashboardSettingsNavItem}
            active={isHrefActive(dashboardSettingsNavItem.href)}
            current={isActiveNavPath(pathname, dashboardSettingsNavItem.href)}
            onPrimaryDown={beginNavTo}
            onPrefetchHover={armPrefetch}
          />
        </SidebarMenu>
      </SidebarFooter>
      </nav>
    </Sidebar>
  )
}
