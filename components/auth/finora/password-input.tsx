'use client'

// Plan Finora P15 (E10b): pole hasła z `login-form.tsx` / `register-form.tsx`
// szablonu — `InputGroup` z przyciskiem oka. Finora steruje polem przez
// `register()` z RHF; u nas formularze idą prosto do akcji serwerowych
// (`app/(auth)/*/actions.ts`), więc pole przyjmuje zwykłe atrybuty `<input>`
// (`id`, `name`, `required`, `minLength`, `autoComplete` …) bez zmian.

// React Imports
import { useState, type ComponentProps } from 'react'

// Third-party Imports
import { RiEyeLine, RiEyeOffLine } from '@remixicon/react'

// Component Imports
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'

export function PasswordInput(props: Omit<ComponentProps<'input'>, 'type'>) {
  const [isVisible, setIsVisible] = useState(false)

  return (
    <InputGroup>
      <InputGroupInput type={isVisible ? 'text' : 'password'} placeholder='••••••••••••••••' {...props} />
      <InputGroupAddon align='inline-end' className='pr-1.5'>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          onClick={() => setIsVisible(prevState => !prevState)}
          disabled={props.disabled}
          className='text-muted-foreground rounded-l-none hover:bg-transparent'
        >
          {isVisible ? <RiEyeOffLine /> : <RiEyeLine />}
          <span className='sr-only'>{isVisible ? 'Ukryj hasło' : 'Pokaż hasło'}</span>
        </Button>
      </InputGroupAddon>
    </InputGroup>
  )
}
