import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Szkielet KPiR w tej samej powłoce co strona (poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości): pasek miesiąca, rząd kart, karta księgi
 * z zakładkami — po wczytaniu nic nie skacze, a zakładki stoją od razu.
 */
export default function KpirLoading() {
  return (
    <div className="ff-tab-panel flex flex-1 flex-col gap-6" aria-busy="true">
      <h1 className="sr-only">Książka przychodów i rozchodów</h1>
      <div className="flex justify-end gap-2">
        <Skeleton className="h-9 w-48 max-sm:flex-1" />
        <Skeleton className="h-9 w-32" />
      </div>
      {/* Wysokość bliska prawdziwemu rzędowi (karta wyniku ~340 px, na xl rozciągnięta
          do pierścienia: 340–450 px zależnie od liczby kolumn) — przy h-64 zakładki
          skakały po wczytaniu o ~200 px (poprawka Bartosza 21.10.2026). */}
      <div className="grid gap-6 xl:grid-cols-3">
        <Skeleton className="h-80 xl:col-span-2 xl:h-96" />
        <Skeleton className="h-80 max-sm:hidden xl:h-96" />
      </div>
      <Card className="flex-1">
        <div className="flex flex-col gap-3 px-4">
          <Skeleton className="h-9 w-72 max-w-full" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </Card>
    </div>
  );
}
