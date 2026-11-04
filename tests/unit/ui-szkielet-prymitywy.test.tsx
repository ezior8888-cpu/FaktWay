// @vitest-environment jsdom
// jsdom jest potrzebny tylko drugiemu blokowi (portal); renderToStaticMarkup
// działa tak samo jak w środowisku node, a migawka serwerowa hooków nie zależy od okna.
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CommandDialog } from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { PortalContainerProvider } from '@/components/ui/portal-container'
import { Sidebar, SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('szkielet panelu — Sidebar (plan Finora §4/E2)', () => {
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <Sidebar variant='inset' collapsible='icon'>
        <div>menu</div>
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger />
      </SidebarInset>
    </SidebarProvider>,
  )

  it('opakowanie ma szerokości 16rem i 3rem', () => {
    expect(html).toContain('--sidebar-width:16rem')
    expect(html).toContain('--sidebar-width-icon:3rem')
  })

  it('jeden próg: lg, nie md', () => {
    expect(html).toContain('lg:flex')
    expect(html).toContain('lg:block')
    expect(html).not.toContain('md:')
  })

  it('przycisk ma max-lg:hidden i polską etykietę, bez angielskich napisów', () => {
    expect(html).toContain('max-lg:hidden')
    expect(html).toContain('Przełącz pasek boczny')
    expect(html).not.toContain('Toggle Sidebar')
    expect(html).not.toMatch(/>Sidebar</)
  })

  it('SidebarInset renderuje <main>', () => {
    expect(html).toContain('<main')
  })
})

describe('paleta poleceń i useIsMobile', () => {
  it('CommandDialog ma domyślny tytuł po polsku', () => {
    // Dialog zamknięty nic nie renderuje — sprawdzamy wartości domyślne przez otwarte okno.
    const open = renderToStaticMarkup(
      <CommandDialog open>
        <div />
      </CommandDialog>,
    )
    // Okno renderuje się w portalu (po stronie klienta), więc w SSR może być puste —
    // wtedy sprawdzamy brak angielskich domyślnych.
    expect(open).not.toContain('Command Palette')
    expect(open).not.toContain('Search for a command')
  })

  it('useIsMobile: migawka serwerowa to false', () => {
    function Probe() {
      return <span>{String(useIsMobile())}</span>
    }
    expect(renderToStaticMarkup(<Probe />)).toContain('false')
  })
})

describe('kontener portali', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function otwarteOkno() {
    return (
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Test okna</DialogTitle>
        </DialogContent>
      </Dialog>
    )
  }

  async function render(node: React.ReactElement) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(node)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    return root
  }

  it('w providerze okno ląduje w [data-slot=portal-root]', async () => {
    await render(<PortalContainerProvider>{otwarteOkno()}</PortalContainerProvider>)
    const kontener = document.querySelector("[data-slot='portal-root']")
    expect(kontener).not.toBeNull()
    expect(kontener?.textContent).toContain('Test okna')
  })

  it('CommandDialog otwarty ma polski tytuł i opis', async () => {
    await render(
      <CommandDialog open>
        <div />
      </CommandDialog>,
    )
    expect(document.body.textContent).toContain('Paleta poleceń')
    expect(document.body.textContent).toContain('Szukaj albo przejdź do ekranu')
  })

  it('poza providerem okno ląduje w document.body', async () => {
    await render(otwarteOkno())
    expect(document.querySelector("[data-slot='portal-root']")).toBeNull()
    const popup = document.querySelector("[data-slot='dialog-content']")
    expect(popup).not.toBeNull()
    expect(popup?.parentElement?.closest('body')).toBe(document.body)
    expect(document.body.textContent).toContain('Test okna')
  })
})
