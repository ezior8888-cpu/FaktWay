'use client'

// Port z szablonu Finora (src/views/settings/index.tsx) — ramka ustawień:
// nagłówek „Ustawienia”, zakładki po lewej, treść po prawej, na telefonie
// menu w Sheet. Różnice: treść to `children` z trasy (każda zakładka ma
// własny adres, plan P14), a nie przełączanie komponentów stanem; lista
// zakładek przychodzi z serwera (rola z `getPageContext`); bez magazynu
// ustawień Finory (zustand) — każda strona czyta swoje dane sama.

// React Imports
import { useState, type ReactNode } from 'react'

// Third-party Imports
import { RiMenuLine } from '@remixicon/react'

// Component Imports
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import SettingsNav from './settings-nav'
import type { SettingsTab } from './settings-tabs'

type SettingsViewProps = {
  tabs: SettingsTab[]
  children: ReactNode
}

const SettingsView = ({ tabs, children }: SettingsViewProps) => {
  // States
  const [isNavOpen, setIsNavOpen] = useState(false)

  return (
    <div className='bg-background flex h-full min-h-0 flex-col border'>
      <div className='flex items-center justify-between gap-2 border-b p-2'>
        <h1 className='text-lg font-semibold'>Ustawienia</h1>

        <Sheet open={isNavOpen} onOpenChange={setIsNavOpen}>
          <SheetTrigger
            render={<Button variant='outline' size='icon-sm' />}
            className='sm:hidden'
            aria-label='Otwórz menu ustawień'
          >
            <RiMenuLine className='size-4' />
          </SheetTrigger>
          <SheetContent side='left' className='w-64 p-0' showCloseButton={false}>
            <SheetTitle className='sr-only'>Menu ustawień</SheetTitle>
            <SettingsNav tabs={tabs} onSelect={() => setIsNavOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>

      <div className='flex flex-1 overflow-hidden'>
        <div className='hidden w-64 shrink-0 overflow-y-auto border-r sm:block'>
          <SettingsNav tabs={tabs} />
        </div>

        <div className='min-w-0 flex-1 overflow-y-auto p-6'>{children}</div>
      </div>
    </div>
  )
}

export default SettingsView
