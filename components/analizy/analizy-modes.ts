/**
 * Dwa rodzaje analiz pod jedną pozycją menu „Analizy” (poprawka Bartosza
 * 21.10.2026: Analizy 1:1 z Finory, przełącznik kosztów i sprzedaży).
 * Osobny plik, a nie stałe w `analizy-header.tsx`, bo czyta je i nagłówek,
 * i przełącznik, który nagłówek renderuje — bez cyklu importów. Nagłówek
 * eksportuje je dalej (`ANALIZY_MODES`, `AnalizyMode`).
 */
export type AnalizyMode = 'sprzedaz' | 'koszty';

/** Kolejność opcji przełącznika: Sprzedaż, potem Koszty. */
export const ANALIZY_MODE_ORDER: readonly AnalizyMode[] = ['sprzedaz', 'koszty'];

export const ANALIZY_MODES: Record<AnalizyMode, { label: string; href: string; title: string; description: string }> = {
  sprzedaz: {
    label: 'Sprzedaż',
    href: '/analizy/sprzedaz',
    title: 'Analiza sprzedaży',
    description: 'Śledź sprzedaż, należności i stałych klientów miesiąc po miesiącu.',
  },
  koszty: {
    label: 'Koszty',
    href: '/analizy/koszty',
    title: 'Analiza kosztów',
    description: 'Śledź wydatki, VAT i stałe koszty miesiąc po miesiącu.',
  },
};
