'use client'

import * as React from 'react'

// Plan Finora §4/E2 (dodatek 1): kontener portali wewnątrz drzewa panelu, żeby
// okna, menu i podpowiedzi dziedziczyły zmienne motywu i skalę .ff-dashboard.
// undefined = brak providera (Base UI używa document.body),
// null = provider jest, ale element jeszcze się nie zamontował (portal czeka).
const PortalContainerContext = React.createContext<HTMLElement | null | undefined>(undefined)

function PortalContainerProvider({ children }: { children: React.ReactNode }) {
  const [el, setEl] = React.useState<HTMLElement | null>(null)

  return (
    <PortalContainerContext.Provider value={el}>
      {children}
      <div data-slot='portal-root' ref={setEl} />
    </PortalContainerContext.Provider>
  )
}

function usePortalContainer() {
  return React.useContext(PortalContainerContext)
}

export { PortalContainerProvider, usePortalContainer }
