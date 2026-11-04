// Zakładki ustawień (plan Finora P14) — odpowiednik `SETTINGS_CATEGORIES`
// z Finory (`src/types/settings/settings-types.ts`), ale jako adresy, nie stan
// komponentu: do `/settings/*` prowadzą maile (TrialEnding, PaymentFailed),
// powrót ze Stripe i FLO, więc adresy się nie zmieniają.
//
// Listę liczy layout NA SERWERZE z roli (`getPageContext`), tak jak dawniej
// `settings/page.tsx`: Przypomnienia tylko właściciel, Zespół i Abonament
// właściciel albo administrator. Strony i tak pilnują roli same
// (`getPageContextWithRole`) — ukrycie zakładki to wygoda, nie zabezpieczenie.

import type { UserRole } from '@/lib/supabase/auth-context'

export type SettingsTab = {
  href: string
  label: string
}

// Kolejność jak w Finorze: General → Security → Notifications → Connected
// Accounts, potem nasze zakładki bez odpowiednika, Privacy & Data na końcu.
export function settingsTabsForRole(role: UserRole): SettingsTab[] {
  const isOwner = role === 'owner'
  const canManage = isOwner || role === 'admin'

  return [
    { href: '/settings', label: 'Firma' },
    { href: '/settings/security', label: 'Bezpieczeństwo' },
    { href: '/settings/notifications', label: 'Powiadomienia' },
    { href: '/settings/ksef', label: 'KSeF' },
    ...(isOwner ? [{ href: '/settings/reminders', label: 'Przypomnienia' }] : []),
    { href: '/settings/accountant', label: 'Księgowa' },
    ...(canManage
      ? [
          { href: '/settings/team', label: 'Zespół' },
          { href: '/settings/billing', label: 'Abonament' }
        ]
      : []),
    { href: '/settings/flo', label: 'FLO' },
    { href: '/settings/audit', label: 'Dziennik zdarzeń' },
    { href: '/settings/account', label: 'Konto i dane (RODO)' }
  ]
}

/**
 * Aktywna zakładka według adresu. `/settings` (Firma) tylko dokładnie —
 * inaczej świeciłaby przy każdej podstronie.
 */
export function isSettingsTabActive(pathname: string, href: string): boolean {
  if (href === '/settings') return pathname === '/settings'

  return pathname === href || pathname.startsWith(`${href}/`)
}
