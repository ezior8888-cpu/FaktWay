'use client';

import Link from 'next/link';
import { PrefetchKind } from 'next/dist/client/components/router-reducer/router-reducer-types';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, type ComponentProps } from 'react';

/**
 * Tyle kursor musi zostać na zakładce, żeby jej strona pobrała się w pełni
 * z wyprzedzeniem. Przelot w poprzek rzędu (np. z kafli do tabeli) trwa
 * krócej, a od wejścia na zakładkę do kliknięcia mija zwykle więcej. Liczy się
 * czas na zakładce, nie bezruch, więc powolny przejazd wzdłuż rzędu pobiera
 * też mijane zakładki. Czekanie na bezruch opóźniłoby pobranie przed zwykłym
 * kliknięciem.
 */
const ZAMIAR_MS = 100;

/** Fokus z klawiatury czeka dłużej, bo Tab przez rząd zatrzymuje go na każdej mijanej zakładce. */
const ZAMIAR_KLAWIATURY_MS = 300;

/** Zdarzenia, którymi link sam pilnuje zamiaru. */
type ZdarzeniaZamiaru = 'onPointerEnter' | 'onPointerLeave' | 'onPointerDown' | 'onFocus' | 'onBlur' | 'onClick';

/**
 * Link zakładki w `SectionTabs`. Z góry nie pobiera nic: `prefetch={false}`
 * zostawia Linkowi samą nawigację, bo każdą trasę, którą pobiera sam, Link
 * pobiera od nowa po każdym `router.refresh()`.
 *
 * Gdy kursor wejdzie na zakładkę albo dojdzie do niej klawiatura:
 * 1. Od razu domyślny `router.prefetch(href)`: drzewo trasy i część do
 *    najbliższego `loading.tsx`, bez renderu strony z danymi. Przejście do
 *    trasy, której drzewa nie ma w pamięci, nie czeka na prefetch w toku,
 *    tylko pobiera stronę samo, a pełny prefetch czekający wtedy na drzewo
 *    pobrałby ją drugi raz. Drzewo zamówione przy wejściu zwykle przychodzi
 *    przed końcem odliczania.
 * 2. Po `ZAMIAR_MS` na zakładce (fokus z klawiatury: `ZAMIAR_KLAWIATURY_MS`)
 *    pełny prefetch (`kind: PrefetchKind.FULL`), czyli strona z danymi.
 *    Kliknięcie po jego odpowiedzi przełącza od razu, a kliknięcie w trakcie
 *    dołącza do pobierania w toku.
 *
 * Bez pobierania z wyprzedzeniem:
 * - zakładka bieżąca (`aria-current="page"`), także gdy adres ma parametry
 *   (KPiR z `?month=`): kursor często na niej stoi, a klik w nią, czyli
 *   zerowanie miesiąca albo filtra, jest rzadki;
 * - dotyk: `pointerenter` przychodzi tuż przed `pointerdown`, a przejście
 *   samo pobiera stronę.
 *
 * Kliknięcie, wyjście kursora, utrata fokusu i zdjęcie zakładki z ekranu
 * kasują odliczanie. Pobierania już zleconego przez `router.prefetch` nie da
 * się cofnąć.
 *
 * `kind` to opcja `router.prefetch` z typów Nexta 16 (`PrefetchOptions`), której
 * dokumentacja nie opisuje. `PrefetchKind` importujemy wprost, więc gdy zniknie
 * przy aktualizacji Nexta, zgłoszą to typy i build. Gdyby typ został, a Next
 * przestał słuchać `kind` (albo trasa dostała częściowy prerender, PPR),
 * pobranie po cichu skończy się na kroku 1. Tego test z atrapą routera nie
 * złapie, tylko pomiar żądań w buildzie produkcyjnym.
 */
export function SectionTabLink({
  href,
  ...props
}: Omit<ComponentProps<typeof Link>, 'href' | 'prefetch' | ZdarzeniaZamiaru> & { href: string }) {
  const current = props['aria-current'] === 'page';
  const router = useRouter();
  const zamiar = useRef<ReturnType<typeof setTimeout> | null>(null);

  function anuluj() {
    if (zamiar.current === null) return;
    clearTimeout(zamiar.current);
    zamiar.current = null;
  }

  function zacznij(ms: number) {
    anuluj();
    if (current) return;
    router.prefetch(href);
    zamiar.current = setTimeout(() => {
      zamiar.current = null;
      router.prefetch(href, { kind: PrefetchKind.FULL });
    }, ms);
  }

  // Zakładka zdjęta z ekranu przed końcem odliczania nie zleca pełnego prefetchu.
  useEffect(
    () => () => {
      if (zamiar.current !== null) clearTimeout(zamiar.current);
    },
    [],
  );

  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'touch') zacznij(ZAMIAR_MS);
      }}
      onPointerLeave={anuluj}
      onPointerDown={anuluj}
      // Tylko fokus z klawiatury: klik myszką i dotyk też ustawiają fokus, ale wtedy przejście już trwa.
      onFocus={(e) => {
        if (e.currentTarget.matches(':focus-visible')) zacznij(ZAMIAR_KLAWIATURY_MS);
      }}
      onBlur={anuluj}
      onClick={anuluj}
    />
  );
}
