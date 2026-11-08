import { Suspense, type ReactNode } from 'react';

import { countLabel, FLO_FORMS } from '@/components/flo/format';
import { FloScheduledPanel } from '@/components/flo/scheduled-panel';
import { FloThreadClient } from '@/components/flo/thread-client';
import { countTodayTasks } from '@/components/flo/timeline';
import type { FloProposalView, FloScheduledView } from '@/types/flo';

import { FloQueueSheet } from '@/components/flo/flo-queue-sheet';

import { FloComposer } from './flo-composer';
import { FloHeader } from './flo-header';
import { FloHistoryPanel } from './flo-history-panel';
import { FloPhotoBanner } from './flo-photo-banner';

/**
 * Ekran agenta: nagłówek, wątek, prawa kolumna, pole rozmowy.
 *
 * Szkielet jest serwerowy, a klienckie są wyspy w środku: wątek (bo woła
 * akcje i trzyma stan wykonywania) i panel zatwierdzonych (bo ma „Wstrzymaj”).
 * Nagłówek, historia i pas rozmowy zostają po stronie serwera — nie mają
 * czego robić w przeglądarce.
 *
 * UKŁAD: wątek jest szeroki i po lewej, bo to on jest treścią; prawa kolumna
 * to listy pomocnicze.
 *
 * NA TELEFONIE PRAWEJ KOLUMNY NIE MA (`hidden lg:flex`). Wcześniej schodziła
 * pod wątek — a że ekran agenta ma zablokowaną wysokość, lądowała poza nim
 * i nie dało się do niej doscrollować. Zamiast tego: liczby miesiąca mieszkają
 * na `/przeplywy` (zakładka „Miesiąc” w dolnej nawigacji), a kolejka i historia
 * otwierają się z chipa nad wątkiem (`FloQueueSheet`). Dzięki temu wątek
 * dostaje CAŁĄ wysokość ekranu zamiast połowy.
 *
 * GNIAZDO `aside` (dodane 30.08.2026 przez tor silnika, zmiana przez DODANIE):
 * dashboard wstrzykuje tędy kartę z liczbami miesiąca, żeby prawa kolumna
 * wyglądała jak na sierpniowej makiecie — statystyki, potem „Zatwierdzone”,
 * potem historia. Bez propa ekran zachowuje się dokładnie jak wcześniej.
 */
export function FloScreen({
  proposals,
  scheduled,
  usingFixtures = false,
  aside,
  showHeader = true,
}: {
  proposals: FloProposalView[];
  scheduled: FloScheduledView[];
  /** true = na ekranie są atrapy; pokazujemy o tym uczciwą adnotację */
  usingFixtures?: boolean;
  /** Trafia na GÓRĘ prawej kolumny, nad „Zatwierdzone”. */
  aside?: ReactNode;
  /** false = nagłówek agenta rysuje strona nadrzędna (dashboard ma własny pasek). */
  showHeader?: boolean;
}) {
  const todayTasks = countTodayTasks(proposals);

  const { readOcrJobIds, failedOcrJobIds } = photoBannerSignals(proposals);

  // Ciaśniej na telefonie: ekran agenta ma zablokowaną wysokość, więc każde
  // 8 px odstępu to 8 px mniej dla wątku — a wątek jest treścią.
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:gap-4 sm:p-4 md:p-6">
      {showHeader ? (
        <FloHeader todayTasks={todayTasks} usingFixtures={usingFixtures} />
      ) : (
        <>
          {/* NA TELEFONIE NAGŁÓWEK AGENTA WRACA. Dashboard chowa go, bo pasek
              nad nim niesie tytuł „Dashboard” — ale poniżej `lg` w pasku stoi
              wordmark FaktFlow, więc bez tego agent nigdzie się nie przedstawia
              i ekran wygląda jak lista powiadomień bez nadawcy.
              Odznaki „TRYB 3” tu NIE MA i nie będzie — powód w `flo-header.tsx`. */}
          <div className="lg:hidden">
            <FloHeader
              todayTasks={todayTasks}
              usingFixtures={usingFixtures}
              extraBadges={
                /* Kolejka jako druga odznaka, nie osobny pas nad wątkiem:
                   własny wiersz zabierał 56 px, a przy zablokowanej wysokości
                   ekranu to jedna piąta tego, co zostaje dla wątku. */
                <FloQueueSheet
                  scheduled={scheduled}
                  className="flex items-center gap-1.5 rounded-full border border-[var(--ff-border)] bg-[var(--ff-surface-chip)] px-2.5 py-1 text-xs text-[var(--ff-text-soft)] transition-colors hover:border-[var(--ff-border-strong)]"
                />
              }
            />
          </div>

          {/* Od `lg` zostaje sam licznik spraw: nagłówek byłby drugim tytułem
              jeden pod drugim (krok 39). */}
          <div className="hidden flex-wrap items-center gap-2 lg:flex">
            <span className="flex items-center gap-1.5 rounded-full border border-[var(--ff-border)] bg-[var(--ff-surface-chip)] px-2.5 py-1 text-xs text-[var(--ff-text-soft)]">
              <span
                aria-hidden
                className="material-symbols-outlined text-[14px] leading-none text-[var(--ff-accent)]"
              >
                bolt
              </span>
              {countLabel(todayTasks, FLO_FORMS.zadanie)} dziś
            </span>

            {usingFixtures ? (
              <span className="rounded-full border border-[var(--ff-warn-border)] bg-[var(--ff-warn-tint)] px-2.5 py-1 text-xs text-[var(--ff-warn-text)]">
                Dane przykładowe
              </span>
            ) : null}
          </div>
        </>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-h-0 flex-col gap-3">
          <Suspense fallback={null}>
            <FloPhotoBanner
              readOcrJobIds={readOcrJobIds}
              failedOcrJobIds={failedOcrJobIds}
            />
          </Suspense>

          {/* Widoczny zastępnik, nie `null`: gdyby ta wyspa kiedyś nie
              wstała, pusty ekran wyglądałby jak „nic nie masz do zrobienia”,
              a to jest komunikat, którego nie wolno pokazać nieprawdziwie. */}
          <Suspense
            fallback={
              <div className="min-h-0 flex-1 rounded-2xl border border-[var(--ff-border)] bg-[var(--ff-surface)] p-4 text-xs text-[var(--ff-text-muted)] md:p-5">
                Zbieram Twoje sprawy…
              </div>
            }
          >
            <FloThreadClient
              proposals={proposals}
              className="min-h-0 flex-1 space-y-6 overflow-y-auto rounded-2xl border border-[var(--ff-border)] bg-[var(--ff-surface)] p-4 md:p-5"
            />
          </Suspense>
          <FloComposer />
        </div>

        <aside className="hidden min-h-0 flex-col gap-4 lg:flex lg:overflow-y-auto">
          {aside}
          <FloScheduledPanel
            scheduled={scheduled}
            className="rounded-2xl border border-[var(--ff-border)] bg-[var(--ff-surface)] p-4"
          />
          <FloHistoryPanel />
        </aside>
      </div>
    </div>
  );
}

/**
 * Co pasek zdjęcia ma wiedzieć o wątku — funkcja czysta, testowana bez Reacta.
 *
 * Liczą się WYŁĄCZNIE karty odczytu zdjęcia z numerem zadania (`ocrCard`).
 * Wcześniej sygnałem była dowolna karta `expense.*` młodsza niż wejście — także
 * karta porażki OCR, skrzynki KSeF, reguły czy brakującego dokumentu — i pasek
 * mówił „Paragon odczytany” nad kartą „Nie odczytałem tego zdjęcia”.
 */
export function photoBannerSignals(proposals: readonly FloProposalView[]): {
  /** zadania OCR, po których job przysłał kartę kosztu */
  readOcrJobIds: string[];
  /** zadania OCR, po których job przysłał kartę „nie odczytałem” */
  failedOcrJobIds: string[];
} {
  const jobIds = (failed: boolean) =>
    proposals.flatMap((p) =>
      p.ocrCard && p.ocrCard.failed === failed && p.ocrCard.ocrJobId ? [p.ocrCard.ocrJobId] : [],
    );

  return { readOcrJobIds: jobIds(false), failedOcrJobIds: jobIds(true) };
}
