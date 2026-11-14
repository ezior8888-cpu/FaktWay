/**
 * Ustawienia firmy na prawdziwym koncie (M10b): karty Firma, KSeF i
 * Przypomnienia z `GET /api/mobile/v1/ustawienia`, do odczytu. Stan KSeF
 * („połączono” tylko z dowodem w środowisku aplikacji) i przypomnienia
 * (tylko właściciel) liczy serwer regułami strony; zmiany zapisuje się na
 * faktway.pl.
 *
 * Jeden magazyn dla konta i firmy (wzór `stan/ksiegowosc.tsx`): Więcej i
 * ekrany ustawień widzą tę samą odpowiedź. Na danych przykładowych
 * `useUstawienia` zwraca `null`.
 */
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';

import type { UstawieniaOdpowiedz } from '@/lib/api/kontrakt';
import { czyscPrzyKoncuSesji } from '@/stan/czyszczenie';
import { useKontoFirmy } from '@/stan/dane';

export type StanUstawien = {
  stan: 'ladowanie' | 'gotowe' | 'blad';
  dane?: UstawieniaOdpowiedz;
  blad?: string;
  odswiez: () => Promise<void>;
};

type Wpis = { stan: StanUstawien['stan']; dane?: UstawieniaOdpowiedz; blad?: string };

const wpisy = new Map<string, Wpis>();
const sluchacze = new Set<() => void>();
const LADOWANIE: Wpis = { stan: 'ladowanie' };
/** Klucze, dla których zapytanie już idzie: Więcej i ekran otwarte razem pytają raz. */
const wToku = new Set<string>();

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

export function useUstawienia(): StanUstawien | null {
  const k = useKontoFirmy();
  const firma = k?.firma?.id;
  const klucz = k?.konto && firma ? `${k.konto.konto.id}:${firma}` : undefined;
  const wpis = useSyncExternalStore(subskrybuj, () => (klucz ? (wpisy.get(klucz) ?? LADOWANIE) : LADOWANIE));

  const pobierz = async (kl: string) => {
    if (!k || wToku.has(kl)) return;
    wToku.add(kl);
    try {
      const w = await k.zapytaj<UstawieniaOdpowiedz>('ustawienia');
      const byl = wpisy.get(kl);
      if (w.ok) ustaw(kl, { stan: 'gotowe', dane: w.dane });
      else ustaw(kl, { stan: byl?.dane ? 'gotowe' : 'blad', dane: byl?.dane, blad: w.blad.komunikat });
    } finally {
      wToku.delete(kl);
    }
  };
  const pobierzTeraz = useEffectEvent((kl: string) => pobierz(kl));
  useEffect(() => {
    if (!klucz) return;
    void pobierzTeraz(klucz);
  }, [klucz]);

  if (!k) return null;
  return {
    stan: wpis.stan,
    dane: wpis.dane,
    blad: wpis.blad,
    odswiez: async () => {
      if (klucz) await pobierz(klucz);
    },
  };
}

/** Status VAT jak na stronie: zwolnienie podmiotowe, sprzedaż zwolniona (art. 43) albo czynny podatnik. */
export function statusVat(f: UstawieniaOdpowiedz['firma']): string {
  if (f.zwolnienie && f.zwolnieniePodmiotowe) return `Zwolniona z VAT (${f.zwolnienie})`;
  const czynny = f.metodaKasowa ? 'Czynny podatnik VAT, metoda kasowa' : 'Czynny podatnik VAT';
  return f.zwolnienie ? `${czynny}, sprzedaż zwolniona (${f.zwolnienie})` : czynny;
}

/** Plakietka KSeF jak na stronie (`settings/ksef`). */
export const NAZWA_STANU_KSEF: Record<UstawieniaOdpowiedz['ksef']['stan'], string> = {
  polaczono: 'Skonfigurowano połączenie',
  do_potwierdzenia: 'Wymaga potwierdzenia',
  brak: 'Brak certyfikatu',
};
