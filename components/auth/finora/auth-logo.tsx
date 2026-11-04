// Plan Finora P15 (E10b): `src/components/shared/Logo.tsx` szablonu —
// znak + nazwa. Od 25.10.2026 logo FaktWay z zestawu (docs/brand/logo);
// wcześniej sam napis, bo zielony znak zdjęto 23.10.2026.

// Component Imports
import { FaktWayLogo } from '@/components/brand/faktway-logo'

// Util Imports
import { cn } from '@/lib/utils'

export function AuthLogo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center', className)}>
      <FaktWayLogo className='h-8' />
    </div>
  )
}
