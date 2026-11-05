import { ExportHistorySkeleton } from '@/components/exports/export-history';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Szkielet ekranu Eksport w tej samej powłoce co strona (poprawka Bartosza
 * 21.10.2026: przeprojektowanie Księgowości) — zakładki i karty stoją tam,
 * gdzie po wczytaniu, więc nic nie skacze. Na telefonie formularz jest
 * zwinięty, dlatego szkielet też.
 */
export default function ExportsLoading() {
  return (
    <div className="ff-tab-panel flex flex-1 flex-col gap-6" aria-busy="true">
      <h1 className="sr-only">Eksport danych księgowych</h1>

      <Card className="shadow-none">
        <CardContent className="flex flex-col gap-6">
          <div className="flex items-center justify-between gap-3 sm:hidden">
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-7 w-16" />
          </div>
          <div className="grid grid-cols-1 gap-6 max-sm:hidden md:grid-cols-2 xl:grid-cols-[minmax(0,6fr)_minmax(0,3fr)_minmax(0,3fr)]">
            <div className="grid gap-2 sm:grid-cols-3 sm:gap-3 md:col-span-2 xl:col-span-1">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-24" />
              ))}
            </div>
            <div className="space-y-3">
              <Skeleton className="h-9 w-64 max-w-full" />
              <Skeleton className="h-9" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-48" />
            </div>
          </div>
          <div className="border-t pt-4">
            <Skeleton className="h-10 w-40 max-sm:w-full sm:ml-auto" />
          </div>
        </CardContent>
      </Card>

      <Card className="flex-1">
        <div className="flex w-full flex-1 flex-col">
          <ExportHistorySkeleton />
        </div>
      </Card>
    </div>
  );
}
