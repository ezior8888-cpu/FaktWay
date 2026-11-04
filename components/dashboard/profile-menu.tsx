'use client'

// Poprawka Bartosza 21.10.2026: menu profilu 1:1 z `src/components/shared/ProfileDropdown.tsx`
// Finory — przycisk z awatarem i zieloną kropką, rozwijka `w-65`: awatar + dwa
// wiersze, potem pozycje, potem wylogowanie. Różnice:
//  - zamiast zdjęcia szary ludzik (nie mamy zdjęć profilowych);
//  - pod nazwą/e‑mailem firma (aktywna organizacja);
//  - „My Accounts” → „Moje firmy” (podmenu z przełączaniem firm — dawny
//    przełącznik z paska), „Settings” → „Ustawienia”, „Monthly Analytics” →
//    „Analiza sprzedaży”; „My Cards” odpada (nie mamy odpowiednika).

// Next Imports
import Link from 'next/link'
import { useRouter } from 'next/navigation'

// React Imports
import { useTransition } from 'react'
import { useFormStatus } from 'react-dom'

// Third-party Imports
import {
  RiAddLine,
  RiBuilding2Line,
  RiCheckLine,
  RiLogoutBoxLine,
  RiPieChartLine,
  RiSettings3Line,
  RiUser3Fill
} from '@remixicon/react'
import { toast } from 'sonner'

// Component Imports
import { signOut } from '@/app/(auth)/login/actions'
import { setActiveOrganizationAction } from '@/app/actions/organizations'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

// Type Imports
import type { DashboardOrgMembershipPreview } from '@/lib/dashboard-shell-data'

const ROLE_LABEL: Record<DashboardOrgMembershipPreview['role'], string> = {
  owner: 'właściciel',
  admin: 'admin',
  member: 'członek',
  accountant: 'księgowy'
}

/** Szary ludzik w kółku — awatar bez zdjęcia profilowego. */
function PersonAvatar({ className }: { className?: string }) {
  return (
    <Avatar className={className}>
      <AvatarFallback className='bg-muted text-muted-foreground'>
        <RiUser3Fill className='size-[60%]' aria-hidden />
      </AvatarFallback>
    </Avatar>
  )
}

/**
 * Pozycja „Wyloguj” jako przycisk wysyłający formularz z akcją `signOut`
 * (ta sama akcja co w arkuszu „Więcej” w `bottom-nav.tsx`). `closeOnClick={false}`:
 * menu zostaje otwarte do przekierowania na `/login`, bo zamknięcie zdjęłoby
 * formularz z drzewa w trakcie wysyłki.
 */
function SignOutItem() {
  const { pending } = useFormStatus()

  return (
    <DropdownMenuItem
      variant='destructive'
      closeOnClick={false}
      disabled={pending}
      nativeButton
      render={<button type='submit' className='w-full' />}
    >
      <RiLogoutBoxLine aria-hidden />
      <span>{pending ? 'Wylogowuję…' : 'Wyloguj'}</span>
    </DropdownMenuItem>
  )
}

/**
 * „Moje firmy”: lista organizacji z przełączaniem (dawny przełącznik z paska).
 * Stan oczekiwania żyje w `ProfileMenu`: kliknięta pozycja zamyka menu, a Base UI
 * odmontowuje wtedy podmenu razem z jego stanem.
 */
function CompaniesSubmenu({
  memberships,
  isPending,
  onSwitch
}: {
  memberships: DashboardOrgMembershipPreview[]
  isPending: boolean
  onSwitch: (organizationId: string, isActive: boolean) => void
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={isPending}>
        <RiBuilding2Line aria-hidden />
        <span>Moje firmy</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className='w-72'>
        <DropdownMenuGroup>
          <DropdownMenuLabel className='text-muted-foreground text-xs font-normal'>Twoje organizacje</DropdownMenuLabel>
          {memberships.map(m => (
            <DropdownMenuItem
              key={m.organizationId}
              disabled={isPending}
              onClick={() => onSwitch(m.organizationId, m.isActive)}
              className='items-start'
            >
              <RiBuilding2Line aria-hidden className='mt-0.5' />
              <div className='flex min-w-0 flex-1 flex-col'>
                <span className='truncate' title={m.name}>
                  {m.name}
                </span>
                <span className='text-muted-foreground truncate font-mono text-[10px]'>
                  NIP: {m.nip} · {ROLE_LABEL[m.role]}
                </span>
              </div>
              {m.isActive ? <RiCheckLine aria-label='Aktywna' className='text-accent-foreground mt-0.5' /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href='/onboarding?action=new' prefetch={false} />}>
          <RiAddLine aria-hidden />
          <span>Dodaj kolejną organizację</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function ProfileMenu({
  email,
  name,
  company,
  memberships,
  defaultOpen
}: {
  email: string
  name?: string
  /** Nazwa aktywnej firmy; `null` — jeszcze się wczytuje (szkielet w `Suspense`). */
  company: string | null
  memberships: DashboardOrgMembershipPreview[]
  defaultOpen?: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleSwitch = (organizationId: string, isActive: boolean) => {
    if (isActive) return
    startTransition(async () => {
      const result = await setActiveOrganizationAction(organizationId)
      if (result.success) router.refresh()
      else toast.error(result.error)
    })
  }

  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant='ghost'
            size='icon'
            className='relative rounded-full hover:bg-transparent disabled:opacity-60'
            aria-label='Menu konta'
            // Do końca przełączania firmy (akcja + odświeżenie) menu jest zablokowane.
            disabled={isPending}
          />
        }
      >
        {/* Kropka przypięta do awatara (jak w nagłówku menu niżej): na dotyku przycisk ma 44 px. */}
        <span className='relative block'>
          <PersonAvatar />
          <span className='ring-card absolute right-0 bottom-0 block size-2 rounded-full bg-green-600 ring-2' aria-hidden />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-65'>
        <DropdownMenuGroup>
          <DropdownMenuLabel className='flex items-center gap-4 px-2 py-2.5 font-normal'>
            <div className='relative shrink-0'>
              <PersonAvatar className='size-10' />
              <span className='ring-card absolute right-0 bottom-0 block size-2 rounded-full bg-green-600 ring-2' aria-hidden />
            </div>
            <div className='flex min-w-0 flex-1 flex-col items-start'>
              <span className='text-foreground w-full truncate text-base font-semibold' title={name ?? email}>
                {name ?? email}
              </span>
              {name ? (
                <span className='text-muted-foreground w-full truncate text-sm' title={email}>
                  {email}
                </span>
              ) : null}
              {company ? (
                <span className='text-muted-foreground w-full truncate text-sm' title={company}>
                  {company}
                </span>
              ) : null}
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup className='p-1'>
          {memberships.length > 0 ? (
            <CompaniesSubmenu memberships={memberships} isPending={isPending} onSwitch={handleSwitch} />
          ) : null}
          <DropdownMenuItem render={<Link href='/settings' />}>
            <RiSettings3Line aria-hidden />
            <span>Ustawienia</span>
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href='/analizy/sprzedaz' />}>
            <RiPieChartLine aria-hidden />
            <span>Analiza sprzedaży</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <form action={signOut}>
          <DropdownMenuGroup className='p-1'>
            <SignOutItem />
          </DropdownMenuGroup>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
