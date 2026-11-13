import { SectionTabLink } from '@/components/lists/section-tab-link';
import { LinkPendingMark } from '@/components/navigation/link-pending-mark';
import { cn } from '@/lib/utils';

/** Zakładka ekranu z listą — osobna strona z własnym adresem. */
export interface SectionTab<T extends string = string> {
  value: T;
  label: string;
  href: string;
}

/**
 * Pierwszy rząd karty z tabelą na ekranach z zakładkami (Faktury, Koszty —
 * poprawka Bartosza 21.10.2026: jedna pozycja w menu zamiast kilku). Wygląd
 * zakładek „line” Finory (`investments/equities/comparison-chart-card.tsx`:
 * `TabsList variant='line'` w całej szerokości karty, wyzwalacze `px-4`,
 * podkreślenie aktywnej), ale semantyka nawigacji: zakładka przełącza stronę,
 * więc `<nav>` z linkami i `aria-current`, a nie `role="tablist"` bez paneli.
 *
 * Wymiary jak w makiecie z `TabsList`/`TabsTrigger`: rząd `h-11` z dolną ramką
 * i `pt-[3px]`, zakładka o 1 px niższa, podkreślenie `h-0.5` tuż nad ramką.
 * Na telefonie mniejsze wcięcia, żeby trzy zakładki zmieściły się na 375 px.
 *
 * Komponent serwerowy (bez stanu): aktywną zakładkę podaje strona.
 *
 * PŁYNNOŚĆ (zgłoszenie Bartosza 23.10.2026, pobieranie zmienione w planie
 * skalowania 3000, sesja 10). Pełny prefetch wszystkich zakładek z góry
 * renderował przy każdym wejściu i po każdym `router.refresh()` całe strony
 * sąsiednich zakładek. Teraz zakładka pobiera się w pełni, z danymi, dopiero
 * gdy kursor zostanie na niej chwilę albo dojdzie do niej klawiatura
 * (`SectionTabLink`). Kliknięcie, gdy strona już przyszła, przełącza od razu;
 * kliknięcie wcześniej i dotyk (bez pobierania z wyprzedzeniem) czekają na
 * serwer. W tym czasie `LinkPendingMark` od razu przenosi podkreślenie na
 * wybraną zakładkę (`.ff-section-tabs` w `globals.css`). W Fakturach,
 * Kosztach i zakładkach JDG stara tabela stoi, aż przyjdzie nowa, a KPiR
 * i Eksport mają własny `loading.tsx`, więc pokazują szkielet.
 *
 * JEDNA STRONA, NIE PODSTRONA (poprawka Bartosza 25.10.2026). Rząd stoi
 * w layoucie sekcji (`(faktury)`, `(koszty)`, `reports`) razem z kaflami
 * i kartą, a zakładka podmienia tylko stronę pod nim — tabelę. Dlatego
 * linki nie przewijają (`scroll={false}`), a `data-ff-keep-scroll` mówi
 * `ShellScrollMemory`, żeby nie wracał na górę: zmiana tabeli nie może
 * ruszać reszty ekranu. W layoucie aktywną zakładkę wybiera `SectionTabsNav`
 * z adresu.
 */
export function SectionTabs<T extends string>({
  label,
  tabs,
  active,
  className,
}: {
  /** `aria-label` nawigacji, np. „Rodzaje faktur”. */
  label: string;
  tabs: readonly SectionTab<T>[];
  /** Aktywna zakładka; `null` — żadna (adres spoza zakładek sekcji). */
  active: T | null;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn('ff-section-tabs flex h-11 w-full shrink-0 items-start border-b px-1 pt-[3px] sm:px-4', className)}
    >
      {tabs.map((tab) => {
        const current = tab.value === active;
        return (
          <SectionTabLink
            key={tab.value}
            href={tab.href}
            scroll={false}
            data-ff-keep-scroll=""
            aria-current={current ? 'page' : undefined}
            className={cn(
              'relative inline-flex h-[calc(100%-1px)] items-center justify-center px-3 text-sm font-medium whitespace-nowrap transition-all outline-none sm:px-4',
              'focus-visible:ring-ring/50 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:outline-1',
              'after:bg-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:opacity-0 after:transition-opacity',
              current
                ? 'text-foreground after:opacity-100'
                : 'text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground',
            )}
          >
            {tab.label}
            <LinkPendingMark />
          </SectionTabLink>
        );
      })}
    </nav>
  );
}
