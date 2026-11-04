import { notFound } from 'next/navigation';

import { COMPARISON_PAGES_PUBLISHED } from '@/lib/marketing/comparisons';

/**
 * Strony porównawcze /vs/* są WYŁĄCZONE od 15.10.2026 (przegląd prawny).
 *
 * Reklama porównawcza jest dozwolona tylko wtedy, gdy porównuje obiektywnie
 * i w sposób sprawdzalny (art. 16 ust. 3 ustawy o zwalczaniu nieuczciwej
 * konkurencji) i nie dyskredytuje konkurenta (art. 16 ust. 1 pkt 4). Te strony
 * miały:
 *  - „opinie użytkowników” z podpisami „grupa FB · 2024”, „Komentarz
 *    z LinkedIn · 2025” — bez źródła, którego dałoby się bronić;
 *  - tabelę braków konkurentów („brak confidence score”, „brak push”) bez
 *    daty i źródła weryfikacji;
 *  - twierdzenia o własnych funkcjach do sprawdzenia („OCR bez limitu stron”,
 *    „uczenie z historii poprawek”).
 * Każda z firm (inFakt, wFirma, iFirma) może z tym pójść do sądu.
 *
 * Włączenie: usuń cytaty bez źródła, przy każdej pozycji o konkurencie podaj
 * źródło i datę sprawdzenia, potwierdź własne funkcje w kodzie, przestaw flagę
 * i dopisz strony do app/sitemap.ts.
 */
export default function ComparisonLayout({ children }: { children: React.ReactNode }) {
  if (!COMPARISON_PAGES_PUBLISHED) notFound();
  return children;
}
