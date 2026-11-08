import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const NAPIS = 'Dane przykładowe';

/**
 * Plakietka „Dane przykładowe” (poprawka Bartosza 21.10.2026): przed
 * weryfikacją KSeF Analizy i KPiR pokazują dane przykładowe, a klient musi
 * wiedzieć, że to nie są jego liczby. Kolory jak plakietki ostrzeżeń
 * (kontrast AA w obu motywach).
 *
 * `skracana` (recenzja 2, E12): obok tytułu karty Pulpitu i Przepływów
 * plakietka na wąskim ekranie ustępuje miejsca tytułowi — zwęża się
 * i skraca napis wielokropkiem (pełny w dymku), zamiast łamać nagłówek
 * w drugą linię. Bez tej flagi (Księgowość, Analizy) znacznik bez zmian.
 */
export function DemoBadge({ skracana = false }: { skracana?: boolean } = {}) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        'h-6 bg-amber-500/15 px-2.5 font-normal text-amber-800 dark:bg-amber-400/15 dark:text-amber-300',
        skracana && 'min-w-0 shrink',
      )}
      title="Twoje dane pojawią się tu po podłączeniu KSeF w ustawieniach."
    >
      {skracana ? <span className="min-w-0 truncate">{NAPIS}</span> : NAPIS}
    </Badge>
  );
}
