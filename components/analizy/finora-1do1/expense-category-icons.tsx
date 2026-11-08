// Kopia 1:1 z finora-src/src/views/pages/money-management/monthly-analytics/expense-category-icons.tsx (Analizy, decyzja Bartosza 21.10.2026): zmienione tylko teksty (z propsów), kwoty (zł, pl-PL), daty (DD.MM.RRRR), importy i źródło danych. Odstępstwa: Finora ma stałą listę 6 kategorii (`Record<ExpenseCategory, …>`); nasze kategorie kosztów to wolny tekst (`category_label`), więc mapa idzie po nazwie (bez wielkości liter i spacji na brzegach), a nieznana nazwa dostaje ogólną metkę.

// Third-party Imports
import {
  RiBankLine,
  RiBriefcaseLine,
  RiCarLine,
  RiComputerLine,
  RiFileList3Line,
  RiMegaphoneLine,
  RiMoreLine,
  RiPriceTag3Line,
  RiRestaurantLine,
  RiShoppingBagLine,
  RiTeamLine
} from '@remixicon/react'

// Type Imports
import type { FinoraIcon } from './types'

const normalize = (label: string) => label.trim().toLocaleLowerCase('pl-PL')

// Kategorie Finory → nasze nazwy kategorii kosztów (food → Reprezentacja,
// shopping → Materiały biurowe, bills → rachunki, transport → paliwo i podróże,
// miscellaneous → Pozostałe). `entertainment` (RiTvLine) nie ma odpowiednika
// w kosztach firmy, więc wypada. `Map`, nie obiekt: nazwa z wolnego tekstu
// („constructor”) nie może trafić w prototyp.
const COST_CATEGORY_ICONS = new Map<string, FinoraIcon>(Object.entries({
  reprezentacja: RiRestaurantLine,
  'materiały biurowe': RiShoppingBagLine,
  telekomunikacja: RiFileList3Line,
  media: RiFileList3Line,
  energia: RiFileList3Line,
  czynsz: RiFileList3Line,
  paliwo: RiCarLine,
  'podróże służbowe': RiCarLine,
  oprogramowanie: RiComputerLine,
  marketing: RiMegaphoneLine,
  'usługi obce': RiBriefcaseLine,
  'usługi finansowe': RiBankLine,
  wynagrodzenia: RiTeamLine,
  pozostałe: RiMoreLine,
  'pozostałe wydatki': RiMoreLine,
  'bez kategorii': RiMoreLine,
  // Faktura zakupu z KSeF bez wydatku (E10) — ikona dokumentu, jak rachunki.
  'faktury z ksef': RiFileList3Line
}))

export function costCategoryIcon(label: string | null): FinoraIcon {
  if (label === null) return RiMoreLine
  return COST_CATEGORY_ICONS.get(normalize(label)) ?? RiPriceTag3Line
}
