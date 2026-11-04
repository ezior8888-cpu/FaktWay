'use client'

import { useMediaQuery } from '@/hooks/use-media-query'

/**
 * Plan Finora §4/E2: jeden próg 1024 px (jak `lg:` w Tailwindzie), a nie 1280 px
 * jak w szablonie. Migawka serwerowa `false` (z `useMediaQuery`) — brak
 * niezgodności hydracji.
 */
export const MOBILE_MEDIA = '(max-width: 1023.98px)'

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_MEDIA)
}
