import { Fragment, type ReactNode } from 'react';

import { PulpitCardError } from '@/components/dashboard/pulpit/card-states';
import { PULPIT_GENERIC_ERROR, pulpitErrorMessage } from '@/components/dashboard/pulpit/pulpit-grid';
import { SectionErrorBoundary } from '@/components/dashboard/section-error-boundary';
import type { TrybDanych } from '@/lib/demo/tryb-danych';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Oprawa kart `/analizy/*` (plan Finora §2.4 pkt 15, wzór: siatka Pulpitu).
 * Każda karta to osobny asynchroniczny loader w `SectionErrorBoundary`:
 * strażnik, który rzuci (faktura w EUR, przyjęta faktura bez środowiska,
 * niepełna strona), zabiera JEDNĄ kartę z treścią wyjątku
 * (`pulpitErrorMessage` — bez angielskiego ogona PostgREST-a), a reszta
 * strony działa. Strona nie woła na swoim poziomie żadnej funkcji z §2.4.
 */

export interface AnalizyCardProps {
  supabase: PageContext['supabase'];
  tenantId: string;
  /** Chwila żądania jako ISO — jeden „teraz” dla wszystkich kart. */
  nowIso: string;
  /** Wybrany miesiąc RRRR-MM (już sprawdzony przez `resolveAnalyticsMonth`). */
  month: string;
  /** Tryb danych strony (`kontekstDanych`) — puste stany zależne od weryfikacji KSeF. */
  tryb: TrybDanych;
  /** Od kiedy koszty z KSeF są pełne (`trybDanych().kosztyKsefOd`, Z9/E10: „KSeF od DD.MM”); `null` — bez zastrzeżenia. */
  kosztyKsefOd?: string | null;
}

/** Dane karty albo karta błędu z treścią wyjątku dla klienta. */
export async function loadAnalizyCard(
  title: string,
  className: string | undefined,
  render: () => Promise<ReactNode>,
): Promise<ReactNode> {
  try {
    return await render();
  } catch (error) {
    const message = pulpitErrorMessage(error);
    if (message === PULPIT_GENERIC_ERROR) console.error(`[analizy] karta „${title}”:`, error);
    return <PulpitCardError title={title} message={message} className={className} />;
  }
}

/**
 * Slot karty `/analizy/*`: dane albo karta błędu (`loadAnalizyCard`) w granicy
 * błędu renderu (komponent kliencki karty).
 *
 * Bez `Suspense` i szkieletu w każdej karcie (poprawka Bartosza 23.10.2026:
 * „przejścia pomiędzy zakładkami nie są już takie clean”, jak Pulpit
 * i Przepływy): siatka pobiera dane wszystkich kart RÓWNOLEGLE i renderuje się
 * raz, w całości, jak Monthly Analytics Finory (`Promise.all` w `AnalizySiatka`).
 * Karta nigdy nie odrzuca — błąd loadera to karta błędu — więc `Promise.all`
 * siatki działa jak `Promise.allSettled`. Trasa ma własny, pusty
 * `loading.tsx` zamiast ogólnego szkieletu segmentu, a wejście treści animuje
 * `ff-route-content`.
 */
export async function analizySlot(
  title: string,
  className: string | undefined,
  karta: () => Promise<ReactNode>,
): Promise<ReactNode> {
  const tresc = await karta();
  return (
    <SectionErrorBoundary
      fallback={<PulpitCardError title={title} message="Nie udało się wyświetlić karty." className={className} />}
    >
      {tresc}
    </SectionErrorBoundary>
  );
}

/** Pozycja siatki: tytuł karty błędu, rozpiętość Finory i karta (`*Slot` z `loadAnalizyCard`). */
export type AnalizyKarta = readonly [
  title: string,
  className: string,
  karta: (props: AnalizyCardProps & { className?: string }) => Promise<ReactNode>,
];

/**
 * Siatka `grid gap-6 md:grid-cols-4` z kartami w kolejności Finory — wszystkie
 * naraz, bez szkieletów (`analizySlot`).
 */
export async function AnalizySiatka({ karty, ...props }: AnalizyCardProps & { karty: readonly AnalizyKarta[] }) {
  const tresc = await Promise.all(
    karty.map(([title, className, karta]) => analizySlot(title, className, () => karta({ ...props, className }))),
  );
  return (
    <div className="grid gap-6 md:grid-cols-4">
      {tresc.map((karta, i) => (
        <Fragment key={karty[i]![0]}>{karta}</Fragment>
      ))}
    </div>
  );
}
