/**
 * Model numeracji dla formularzy faktury (krok 2.5): serie do wyboru
 * i podpowiedź numeru rodzaju dokumentu. Bez zależności od bazy, więc
 * formularz w przeglądarce go importuje (dane liczy `lib/numeracja/baza.ts`).
 */
import type { InvoiceKind } from '@/lib/numeracja/wzor';

/** Opcja serii w formularzu; `id: null` to numeracja jak dotąd bez zapisanej serii. */
export interface NumberingOption {
  id: string | null;
  name: string;
  pattern: string | null;
  /** Podpowiedź numeru tej serii dla rodzaju dokumentu; `null`: bez podpowiedzi. */
  preview: string | null;
}

export interface InvoiceNumbering {
  kind: InvoiceKind;
  options: NumberingOption[];
  /** Seria domyślna rodzaju (wybrana w formularzu); `null` bez serii. */
  selectedId: string | null;
}

/** Wybrana opcja (albo pierwsza): z niej formularz bierze podpowiedź i serię. */
export function selectedNumberingOption(numbering: InvoiceNumbering | null | undefined): NumberingOption | null {
  if (!numbering) return null;
  return numbering.options.find((o) => o.id === numbering.selectedId) ?? numbering.options[0] ?? null;
}
