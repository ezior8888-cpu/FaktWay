/**
 * Ładowanie tras z kartami Finory (Pulpit, Przepływy, Analizy) — poprawka
 * Bartosza 23.10.2026: „przejścia pomiędzy zakładkami nie są już takie clean”.
 *
 * Bez szkieletu: ogólny szkielet segmentu `(dashboard)/loading.tsx` nie
 * pasuje do siatki Finory i migał przed każdą stroną. Tu tylko puste miejsce
 * tej samej wysokości (stopka nie podskakuje), a strona — gdy wszystkie karty
 * mają dane — wchodzi w całości z animacją `ff-route-content`. Szablon trasy
 * (`ff-route-template`) i tak animuje się przy kliknięciu.
 */
export function LadowanieBezSzkieletu() {
  return <div className="min-h-[70vh]" aria-busy="true" aria-label="Ładowanie" />;
}
