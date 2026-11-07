'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Zapytanie medialne jako stan Reacta.
 *
 * DLACZEGO `useSyncExternalStore`, A NIE `useState` + `useEffect`.
 * Wariant z efektem renderuje najpierw wartość domyślną, potem prawdziwą —
 * czyli jedną klatkę złego układu i ostrzeżenie `react-hooks/set-state-in-effect`.
 * `useSyncExternalStore` czyta wartość w tej samej fazie, w której React
 * renderuje, i ma osobną migawkę serwerową.
 *
 * Migawka serwerowa to zawsze `false`. Serwer nie zna szerokości okna, a
 * fałsz znaczy tutaj „wariant wąski” — czyli na serwerze rysujemy telefon
 * i rozwijamy do komputera po hydracji. Odwrotnie byłoby gorzej: układ
 * biurkowy wciśnięty w 375 px rozjeżdża stronę w poziomie, a układ telefonu
 * na szerokim ekranie jest tylko przez moment za wąski.
 *
 * UŻYWAJ TEGO DO STRUKTURY, NIE DO WYGLĄDU. Kolor, odstęp czy widoczność
 * załatwia `lg:` w klasach — bez JavaScriptu i bez czekania na hydrację.
 * Ten hak jest po to, żeby NIE MONTOWAĆ drugiego drzewa: dwa `Dialog`i
 * naraz przechwytują ognisko i blokują przewijanie, nawet gdy jeden ma
 * `display: none`.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined') return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Próg, na którym panel przechodzi z układu telefonu na biurkowy: znika dolna
 * nawigacja, wraca sidebar. Ta sama wartość co `lg:` w Tailwindzie i co
 * `--ff-sidebar-w` w `globals.css` — trzymana w jednym miejscu, żeby próg
 * w JavaScripcie nie rozjechał się z progiem w arkuszu.
 */
export const DESKTOP_MEDIA = '(min-width: 1024px)';

/** Skrót na `useMediaQuery(DESKTOP_MEDIA)` — czytelniejszy w wywołaniach. */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_MEDIA);
}

/** Systemowa opcja „ogranicz ruch”. */
export const REDUCED_MOTION_MEDIA = '(prefers-reduced-motion: reduce)';

/**
 * Zamiennik `useReducedMotion` z framer-motion, bezpieczny dla hydratacji.
 *
 * `useReducedMotion` czyta `matchMedia` już w pierwszym renderze klienta,
 * a serwer zawsze odpowiada „nie”. Przy włączonym „ogranicz ruch” komponent
 * rysował wtedy przy hydratacji inne drzewo niż serwer: React zgłaszał
 * „Hydration failed” i budował stronę od zera (albo, przy różnicy samego
 * `style`, zostawiał serwerowe `opacity: 0`). Tutaj pierwszy render klienta
 * zgadza się z serwerem (`false`), a prawdziwa wartość przychodzi zaraz po
 * hydratacji. Wynik końcowy jest ten sam co wcześniej.
 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_MEDIA);
}
