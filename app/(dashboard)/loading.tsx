import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Segment `(dashboard)` — lekki szkielet podczas streamowania RSC (bez logiki).
 *
 * Kształt ekranu Finory, nie dawny „tytuł + podtytuł + trzy kafle”: strony
 * panelu nie mają widocznego tytułu, tylko kartę kafli i kartę z listą. Stary
 * szkielet zaczynał się od dużego nagłówka, którego potem nie było, więc po
 * wczytaniu cała treść podjeżdżała o ~70 px do góry (zgłoszenie Bartosza
 * 23.10.2026, „ładowanie się zakładek”). Strony z własnym rzędem zakładek mają
 * dokładniejsze szkielety (`reports/kpir/loading.tsx`, sekcja listy Cyklicznych).
 */
export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6 pb-10" aria-busy="true" aria-label="Ładowanie">
      <Card className="shadow-none">
        <CardContent className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <div className="space-y-2">
                <Skeleton className="h-7 w-24" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="size-10 shrink-0" />
            </div>
          ))}
        </CardContent>
      </Card>
      <Card className="shadow-none">
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-9 w-72 max-w-full" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
