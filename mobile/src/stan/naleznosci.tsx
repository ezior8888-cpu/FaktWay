/**
 * Należności na prawdziwym koncie (M10a): lista „Po terminie” z
 * `GET /api/mobile/v1/naleznosci`, ta sama co na stronie (te same faktury,
 * stan przypomnień, limit 100), i to, na co pozwala rola w firmie.
 *
 * Jeden wspólny magazyn dla konta i firmy: lista w Fakturach i ekran
 * przypomnienia widzą tę samą wersję, więc wstrzymanie albo zlecenie na
 * jednym ekranie od razu widać na drugim. Ostatnia lista zostaje w pamięci,
 * powrót na ekran pokazuje ją od razu, a świeżą dociąga w tle
 * (ZASADY-DESIGNU.md, sekcja 5). Inne konto albo firma mają inny klucz.
 * Na danych przykładowych `useNaleznosci` zwraca `null`. Kwoty z serwera są w
 * złotych; ekrany pokazują je przez `grosze()` jak resztę modelu telefonu.
 */
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';

import type { NaleznosciOdpowiedz, NaleznoscTelefonu } from '@/lib/api/kontrakt';
import type { Wynik } from '@/lib/api/rdzen';
import { czyscPrzyKoncuSesji } from '@/stan/czyszczenie';
import { useKontoFirmy } from '@/stan/dane';

export type StanNaleznosci = {
  stan: 'ladowanie' | 'gotowe' | 'blad';
  dane?: NaleznosciOdpowiedz;
  /** Zdanie dla klienta, gdy ostatnie pobranie się nie udało. */
  blad?: string;
  odswiez: () => Promise<void>;
  /** Zmiana jednej pozycji od razu (np. wstrzymanie), zanim lista przyjdzie od nowa. */
  zmien: (id: string, zmiana: Partial<NaleznoscTelefonu>) => void;
};

type Wpis = { stan: StanNaleznosci['stan']; dane?: NaleznosciOdpowiedz; blad?: string };

const wpisy = new Map<string, Wpis>();
const sluchacze = new Set<() => void>();

function ustaw(klucz: string, wpis: Wpis): void {
  wpisy.set(klucz, wpis);
  for (const s of sluchacze) s();
}

function subskrybuj(sluchacz: () => void): () => void {
  sluchacze.add(sluchacz);
  return () => sluchacze.delete(sluchacz);
}

czyscPrzyKoncuSesji(() => {
  wpisy.clear();
  for (const s of sluchacze) s();
});

function przyjmij(klucz: string, w: Wynik<NaleznosciOdpowiedz>): void {
  const byl = wpisy.get(klucz);
  if (w.ok) ustaw(klucz, { stan: 'gotowe', dane: w.dane });
  // Błąd po udanym pobraniu zostawia listę na ekranie (z poprzedniego razu).
  else ustaw(klucz, { stan: byl?.dane ? 'gotowe' : 'blad', dane: byl?.dane, blad: w.blad.komunikat });
}

const LADOWANIE: Wpis = { stan: 'ladowanie' };

/** `wlaczone`: pobiera dopiero, gdy ekran pokazuje należności (np. widok „Po terminie”). */
export function useNaleznosci(wlaczone = true): StanNaleznosci | null {
  const k = useKontoFirmy();
  const firma = k?.firma?.id;
  const klucz = k?.konto && firma ? `${k.konto.konto.id}:${firma}` : undefined;
  const wpis = useSyncExternalStore(subskrybuj, () => (klucz ? (wpisy.get(klucz) ?? LADOWANIE) : LADOWANIE));

  const zapytaj = k?.zapytaj;
  const pobierzTeraz = useEffectEvent(() => zapytaj?.<NaleznosciOdpowiedz>('naleznosci'));
  useEffect(() => {
    if (!klucz || !wlaczone) return;
    void pobierzTeraz()?.then((w) => przyjmij(klucz, w));
  }, [klucz, wlaczone]);

  if (!k) return null;
  return {
    stan: wpis.stan,
    dane: wpis.dane,
    blad: wpis.blad,
    odswiez: async () => {
      if (!klucz) return;
      przyjmij(klucz, await k.zapytaj<NaleznosciOdpowiedz>('naleznosci'));
    },
    zmien: (id, zmiana) => {
      const teraz = klucz ? wpisy.get(klucz) : undefined;
      if (!klucz || !teraz?.dane) return;
      ustaw(klucz, { ...teraz, dane: { ...teraz.dane, faktury: teraz.dane.faktury.map((f) => (f.id === id ? { ...f, ...zmiana } : f)) } });
    },
  };
}

export { podpisPrzypomnien } from '@/lib/naleznosci';
