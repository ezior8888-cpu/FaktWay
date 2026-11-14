/**
 * Księgowość na prawdziwym koncie (M10b): „Ten miesiąc” z
 * `GET /api/mobile/v1/ksiegowosc`, to samo wyliczenie co strona
 * `reports/ten-miesiac` (terminy, kwoty, dane do przelewu, stan wersji i zapłat).
 *
 * Jeden magazyn dla konta, firmy i miesiąca (wzór `stan/naleznosci.tsx`): lista
 * i arkusz „Dane do przelewu” widzą tę samą wersję, a zapis na jednym ekranie
 * od razu widać na drugim. Odpowiedź dla miesiąca domyślnego (poprzedniego,
 * jak strona) trafia też pod klucz właściwego miesiąca. Kwoty są w groszach.
 * Na danych przykładowych `useTenMiesiac` zwraca `null`.
 */
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';

import type { PozycjaRozliczeniaTelefonu, TenMiesiacOdpowiedz } from '@/lib/api/kontrakt';
import type { Wynik } from '@/lib/api/rdzen';
import { czyscPrzyKoncuSesji } from '@/stan/czyszczenie';
import { useKontoFirmy } from '@/stan/dane';

export type StanTenMiesiac = {
  stan: 'ladowanie' | 'gotowe' | 'blad';
  dane?: TenMiesiacOdpowiedz;
  blad?: string;
  odswiez: () => Promise<void>;
};

type Wpis = { stan: StanTenMiesiac['stan']; dane?: TenMiesiacOdpowiedz; blad?: string };

const wpisy = new Map<string, Wpis>();
const sluchacze = new Set<() => void>();
const LADOWANIE: Wpis = { stan: 'ladowanie' };

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

function przyjmij(baza: string, klucz: string, w: Wynik<TenMiesiacOdpowiedz>): void {
  const byl = wpisy.get(klucz);
  if (w.ok) {
    ustaw(klucz, { stan: 'gotowe', dane: w.dane });
    ustaw(`${baza}:${w.dane.miesiac}`, { stan: 'gotowe', dane: w.dane });
  } else {
    ustaw(klucz, { stan: byl?.dane ? 'gotowe' : 'blad', dane: byl?.dane, blad: w.blad.komunikat });
  }
}

/** `miesiac`: RRRR-MM albo `undefined` (domyślny, poprzedni miesiąc). */
export function useTenMiesiac(miesiac?: string): StanTenMiesiac | null {
  const k = useKontoFirmy();
  const firma = k?.firma?.id;
  const baza = k?.konto && firma ? `${k.konto.konto.id}:${firma}` : undefined;
  const klucz = baza ? `${baza}:${miesiac ?? 'domyslny'}` : undefined;
  const wpis = useSyncExternalStore(subskrybuj, () => (klucz ? (wpisy.get(klucz) ?? LADOWANIE) : LADOWANIE));
  const sciezka = miesiac ? `ksiegowosc?miesiac=${miesiac}` : 'ksiegowosc';

  const zapytaj = k?.zapytaj;
  const pobierzTeraz = useEffectEvent(() => zapytaj?.<TenMiesiacOdpowiedz>(sciezka));
  useEffect(() => {
    if (!baza || !klucz) return;
    void pobierzTeraz()?.then((w) => przyjmij(baza, klucz, w));
  }, [baza, klucz]);

  if (!k) return null;
  return {
    stan: wpis.stan,
    dane: wpis.dane,
    blad: wpis.blad,
    odswiez: async () => {
      if (!baza || !klucz) return;
      przyjmij(baza, klucz, await k.zapytaj<TenMiesiacOdpowiedz>(sciezka));
    },
  };
}

const MIESIAC = new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric' });

/** „październik 2026” z RRRR-MM. */
export function nazwaMiesiaca(miesiac: string): string {
  return MIESIAC.format(new Date(`${miesiac}-15T12:00:00Z`));
}

/** Ile zostało do zapłaty z pozycji: kwota minus to, co już zapłacono (dopłata po nowej wersji). */
export function doZaplatyGr(p: PozycjaRozliczeniaTelefonu): number {
  return p.kwotaGr === null ? 0 : Math.max(0, p.kwotaGr - p.zaplaconoGr);
}
