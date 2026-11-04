// Formaty kwot kart Analiz w kopii 1:1 z Finory (decyzja Bartosza 21.10.2026:
// „przetłumacz i dopasuj”). Finora formatuje w USD (`Intl.NumberFormat('en-US',
// { currency: 'USD' })`); u nas złote po polsku (plan Finora §7.1), wspólne
// z Pulpitem. Moduł bez importów serwerowych — używają go i karty klienckie
// (trend, koło, kalendarz), i serwerowe.

import { formatPlInt, formatPlMoney } from '@/lib/format/pl'

/** Minus typograficzny (§7.1) — „−1230,00 zł”, nie „-1230,00 zł”. */
const MINUS = '−'

/**
 * Pełna kwota w złotych: „46,00 zł”, „−1230,00 zł”, „12 345,67 zł”.
 * Najpierw grosze, potem znak — szum po korekcie zerującej (−0,001) daje
 * „0,00 zł”, nie „−0,00 zł”.
 */
export function formatZl(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return `${rounded < 0 ? MINUS : ''}${formatPlMoney(Math.abs(rounded))} zł`
}

const axisCompact = new Intl.NumberFormat('pl-PL', { notation: 'compact', maximumFractionDigits: 1 })

/**
 * Podpis osi Y trendu: „0”, „300”, „1,2 tys.”, „120 tys.”, „1,2 mln”, bez
 * „zł”. Finora trzyma oś w `width={48}` i tego nie zmieniamy (Bartosz: „nie
 * zmieniaj rozmiarów”) — „120 tys. zł” by się nie zmieściło; pełna kwota
 * w złotych jest w podpowiedzi.
 */
export function formatAxisMoney(v: number): string {
  if (v === 0 || !Number.isFinite(v)) return '0'
  const sign = v < 0 ? MINUS : ''
  const abs = Math.abs(v)
  if (abs < 1000) return `${sign}${formatPlInt(abs)}`
  return `${sign}${axisCompact.format(abs)}`
}

/**
 * Legenda koła Finory mieści krótkie nazwy kategorii („Food”, „Bills”); u nas
 * kategorie i produkty to wolny tekst. Poprawka 21.10.2026 (pomiar podglądu):
 * sztywne 12 znaków ucinało nasze kanoniczne kategorie („Usługi fina…”),
 * a nazwy produktów z jednostką z lib (`Abonament serwisowy (mies.)`) i tak
 * zawijały legendę do 3 rzędów, więc recharts zmniejszał koło (promień 69,3
 * zamiast 77,1 px). Teraz:
 * - w legendzie nazwa bez jednostki z końca — jednostka nic tu nie mówi,
 *   pełna etykieta zostaje w liście obok, w `title` i w tekście dla czytnika;
 * - szerokość pozycji pilnuje CSS w `category-breakdown-chart.tsx` (6 pozycji
 *   zawsze w 2 rzędach), z wielokropkiem tylko, gdy nazwa się nie mieści;
 * - ten limit znaków to tylko górna granica dla skrajnie długiego tekstu.
 */
export const PIE_LEGEND_MAX_CHARS = 24

/** Jednostka z `productBreakdown` na końcu etykiety: „ (mies.)”, „ (godz.)”. */
const TRAILING_UNIT = /\s*\([^()]*\)\s*$/

function cutChars(text: string, max: number): string {
  // `Array.from` liczy znaki, nie połówki par UTF-16 (emoji w nazwie produktu).
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

export function legendLabel(label: string, max = PIE_LEGEND_MAX_CHARS): string {
  const trimmed = label.trim()
  // Sama jednostka bez nazwy zostaje — pusta pozycja legendy byłaby gorsza.
  return cutChars(trimmed.replace(TRAILING_UNIT, '') || trimmed, max)
}

/**
 * Legenda całego koła. `rankProducts` grupuje po nazwie i jednostce, więc
 * „Konsultacje (godz.)” i „Konsultacje (szt.)” to dwa wycinki — bez jednostki
 * dostałyby w legendzie tę samą nazwę przy dwóch kolorach. Takie zostają
 * z jednostką; pozostałe idą przez `legendLabel`.
 */
export function legendLabels(labels: readonly string[], max = PIE_LEGEND_MAX_CHARS): string[] {
  const short = labels.map(label => legendLabel(label, max))
  return labels.map((label, i) =>
    short.indexOf(short[i]!) === short.lastIndexOf(short[i]!) ? short[i]! : cutChars(label.trim(), max)
  )
}
