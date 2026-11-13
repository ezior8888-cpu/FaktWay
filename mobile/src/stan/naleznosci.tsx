/**
 * Należności na prawdziwym koncie (M10a): lista „Po terminie” z
 * `GET /api/mobile/v1/naleznosci`, ta sama co na stronie (te same faktury,
 * stan przypomnień, limit 100), i to, na co pozwala rola w firmie.
 *
 * Ostatnia lista zostaje w pamięci dla konta i firmy, więc ekran przypomnienia
 * i powrót na listę pokazują ją od razu, a świeżą dociągają w tle
 * (ZASADY-DESIGNU.md, sekcja 5). Inne konto albo firma mają inny klucz.
 * Na danych przykładowych `useNaleznosci` zwraca `null`.
 */
import { useEffect, useEffectEvent, useState } from 'react';

import type { NaleznosciOdpowiedz, NaleznoscTelefonu } from '@/lib/api/kontrakt';
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

const ostatnie = new Map<string, NaleznosciOdpowiedz>();

/** `wlaczone`: pobiera dopiero, gdy ekran pokazuje należności (np. widok „Po terminie”). */
export function useNaleznosci(wlaczone = true): StanNaleznosci | null {
  const k = useKontoFirmy();
  const firma = k?.firma?.id;
  const klucz = k?.konto && firma ? `${k.konto.konto.id}:${firma}` : undefined;
  const [stan, setStan] = useState<{ klucz?: string; stan: StanNaleznosci['stan']; dane?: NaleznosciOdpowiedz; blad?: string }>(() => ({
    klucz,
    stan: klucz && ostatnie.has(klucz) ? 'gotowe' : 'ladowanie',
    dane: klucz ? ostatnie.get(klucz) : undefined,
  }));
  // Inna firma albo konto: dane poprzedniej znikają przy tym samym rysowaniu.
  if (stan.klucz !== klucz) {
    setStan({ klucz, stan: klucz && ostatnie.has(klucz) ? 'gotowe' : 'ladowanie', dane: klucz ? ostatnie.get(klucz) : undefined });
  }

  const przyjmij = (k2: string, w: Awaited<ReturnType<NonNullable<typeof k>['zapytaj']>>) => {
    if (w.ok) {
      const dane = w.dane as NaleznosciOdpowiedz;
      ostatnie.set(k2, dane);
      setStan((s) => (s.klucz === k2 ? { klucz: k2, stan: 'gotowe', dane } : s));
    } else {
      setStan((s) => (s.klucz === k2 ? { ...s, stan: s.dane ? 'gotowe' : 'blad', blad: w.blad.komunikat } : s));
    }
  };
  const pobierz = async (): Promise<void> => {
    if (!k || !klucz) return;
    przyjmij(klucz, await k.zapytaj<NaleznosciOdpowiedz>('naleznosci'));
  };
  const poPobraniu = useEffectEvent(przyjmij);
  const zapytaj = k?.zapytaj;
  const zapytajTeraz = useEffectEvent(() => zapytaj?.<NaleznosciOdpowiedz>('naleznosci'));
  useEffect(() => {
    if (!klucz || !wlaczone) return;
    let biezace = true;
    void zapytajTeraz()?.then((w) => {
      if (biezace) poPobraniu(klucz, w);
    });
    return () => {
      biezace = false;
    };
  }, [klucz, wlaczone]);

  if (!k) return null;
  return {
    stan: stan.stan,
    dane: stan.dane,
    blad: stan.blad,
    odswiez: pobierz,
    zmien: (id, zmiana) => {
      if (!klucz) return;
      setStan((s) => {
        if (!s.dane || s.klucz !== klucz) return s;
        const dane = { ...s.dane, faktury: s.dane.faktury.map((f) => (f.id === id ? { ...f, ...zmiana } : f)) };
        ostatnie.set(klucz, dane);
        return { ...s, dane };
      });
    },
  };
}

export { podpisPrzypomnien } from '@/lib/naleznosci';
