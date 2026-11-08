import { LadowanieBezSzkieletu } from '@/components/dashboard/ladowanie-bez-szkieletu';

/**
 * Analizy (sprzedaż i koszty): puste miejsce zamiast ogólnego szkieletu
 * segmentu, jak Pulpit i Przepływy (poprawka Bartosza 23.10.2026). Zmiana
 * miesiąca (`?miesiac=`) zostawia na ekranie poprzedni miesiąc, aż nowy jest
 * gotowy — wybór miesiąca jest w tym czasie wyłączony (`MonthSelector`).
 */
export default function AnalizyLoading() {
  return <LadowanieBezSzkieletu />;
}
