/**
 * Dane prawdziwego konta (etap M7; plan aplikacji 4.3, „Stan po M6”).
 *
 * - Konto i firmy z `GET /api/mobile/v1/konto`. Firma: ostatnio wybrana na tym
 *   telefonie, gdy nadal jest dostęp, inaczej `aktywnaFirma` z serwera.
 * - Faktury wystawione i skrzynka KSeF wprost z bazy (RLS, `x-active-org`,
 *   `lib/dane/zapytania.ts`), podmienione w stanie ekranów (`PodmienStan`).
 * - Najpierw pokazujemy dane z poprzedniego otwarcia (`lib/dane/pamiec-plikow.ts`),
 *   świeże dociągamy w tle. Bez internetu zostają te z pamięci z datą.
 * - `POST /api/mobile/v1/sesja` raz na sesję, po pełnym logowaniu (wpis w
 *   historii logowań i mail o nowym urządzeniu, jak na stronie).
 *
 * Dane należą do jednego konta: zmiana konta albo wylogowanie zeruje je w
 * pamięci od razu (przy rysowaniu, zanim cokolwiek się pokaże), a pobrania
 * zaczęte wcześniej przepadają (`pokolenie`). Pliki czyści sesja przy
 * wylogowaniu (`stan/sesja.tsx`).
 *
 * Na danych przykładowych (bez adresu bazy) ten dostawca nic nie robi.
 */
import { createContext, use, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { Faktura, FakturaKosztowa } from '@/dane-przykladowe';
import { naStronie } from '@/komponenty/na-stronie';
import type { BladApi } from '@/lib/api/bledy';
import type { FirmaKonta, KontoOdpowiedz, SesjaOdpowiedz } from '@/lib/api/kontrakt';
import { zapytajApi } from '@/lib/api/polaczenie';
import { dzienWarszawa } from '@/lib/dane/mapowanie';
import { pamiec } from '@/lib/dane/pamiec-plikow';
import { pobierzFaktury, pobierzSkrzynke } from '@/lib/dane/zapytania';
import { daneTokenu } from '@/lib/logowanie/token';
import { supabase, ustawienia } from '@/lib/supabase';
import { PodmienStan, type Stan, type StanDanych } from '@/stan/faktury';
import { useSesja } from '@/stan/sesja';

type Lista<T> = { lista: T[]; pelna: boolean };

type Pobranie = { stan: StanDanych['stan']; blad?: string; bezSieci: boolean };

type Dane = {
  konto?: KontoOdpowiedz;
  /** `undefined`: jeszcze nie wiadomo; `null`: konto bez firmy. */
  firmaId?: string | null;
  faktury?: Lista<Faktura>;
  skrzynka?: Lista<FakturaKosztowa>;
  zapisano?: string;
  pobranie: Pobranie;
};

const PUSTE: Dane = { pobranie: { stan: 'ladowanie', bezSieci: false } };

const PUSTA_LISTA = { lista: [], pelna: true };

/** Powrót do aplikacji po tylu minutach pobiera dane od nowa. */
const SWIEZE_MS = 2 * 60 * 1000;

/** Bez internetu próbujemy znowu co tyle, dopóki aplikacja jest na wierzchu. */
const PONOW_BEZ_SIECI_MS = 30 * 1000;

const KLUCZ_SESJI_ZAPISANEJ = 'sesja-zapisana';
const kluczFirmy = (uzytkownik: string) => `firma.${uzytkownik}`;

/** Firma z ostatniego wyboru na tym telefonie, gdy nadal jest na liście; inaczej ta od serwera. */
function wybierzFirme(konto: KontoOdpowiedz, zapamietana: string | null): string | null {
  return konto.firmy.find((f) => f.id === zapamietana)?.id ?? konto.aktywnaFirma;
}

export type KontoFirmy = {
  konto?: KontoOdpowiedz;
  firma?: FirmaKonta;
  wybierzFirme: (id: string) => void;
};

const Kontekst = createContext<KontoFirmy | null>(null);

/** Konto i firma z `GET /konto`; `null` na danych przykładowych. */
export function useKontoFirmy(): KontoFirmy | null {
  return use(Kontekst);
}

/** Nazwa firmy do blokady i karty konta: z bazy albo z danych przykładowych. */
export function useNazwaFirmy(): string {
  const k = use(Kontekst);
  const { konto } = useSesja();
  return k?.firma?.nazwa ?? konto?.firma ?? '';
}

export function DaneKonta({ children }: { children: ReactNode }) {
  // `supabase` jest stałą modułu, więc ten warunek nie zmienia się w trakcie działania.
  if (!supabase) return children;
  return <DaneZBazy>{children}</DaneZBazy>;
}

/** Wpis logowania raz na sesję; nieudany (np. bez sieci) ponawia następne pobranie. */
async function zapiszLogowanie(): Promise<void> {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  const sesja = daneTokenu(data.session?.access_token).sesja;
  if (!sesja) return;
  if ((await ustawienia.wczytaj(KLUCZ_SESJI_ZAPISANEJ).catch(() => null)) === sesja) return;
  const w = await zapytajApi<SesjaOdpowiedz>('sesja', { metoda: 'POST' });
  if (w.ok) await ustawienia.zapisz(KLUCZ_SESJI_ZAPISANEJ, sesja).catch(() => undefined);
}

type ZPamieci = {
  konto?: KontoOdpowiedz;
  firma?: string | null;
  faktury?: { dane: Lista<Faktura>; zapisano: string };
  skrzynka?: { dane: Lista<FakturaKosztowa>; zapisano: string };
};

/** Konto, wybrana firma i jej dane z poprzedniego otwarcia (bez sieci). */
async function odczytajPamiec(u: string): Promise<ZPamieci> {
  const [konto, zapamietana] = await Promise.all([pamiec.czytaj<KontoOdpowiedz>('konto', u, null), ustawienia.wczytaj(kluczFirmy(u)).catch(() => null)]);
  if (!konto) return {};
  const firma = wybierzFirme(konto.dane, zapamietana);
  if (!firma) return { konto: konto.dane, firma };
  const [faktury, skrzynka] = await Promise.all([pamiec.czytaj<Lista<Faktura>>('faktury', u, firma), pamiec.czytaj<Lista<FakturaKosztowa>>('skrzynka', u, firma)]);
  return { konto: konto.dane, firma, faktury, skrzynka };
}

function DaneZBazy({ children }: { children: ReactNode }) {
  const { stan: stanSesji, konto: kontoSesji, wyloguj, wymagajKodu } = useSesja();
  // Propozycja Face ID przychodzi po pełnym logowaniu: dane mogą się już ładować.
  const uzytkownik = stanSesji === 'aktywna' || stanSesji === 'propozycja' ? kontoSesji?.id : undefined;

  const [dane, setDane] = useState<Dane>(PUSTE);
  const [wlasciciel, setWlasciciel] = useState(uzytkownik);
  // Inne konto albo wylogowanie: dane poprzedniego znikają przy tym samym rysowaniu.
  if (wlasciciel !== uzytkownik) {
    setWlasciciel(uzytkownik);
    setDane(PUSTE);
  }

  const pokolenie = useRef(0);
  const ostatnioUdane = useRef(0);
  const firmaPokazana = useRef<string | null | undefined>(undefined);

  const obsluzBlad = (b: BladApi) => {
    // Odświeżenie sesji już się nie udało (`lib/api/rdzen.ts`): koniec sesji na tym telefonie.
    if (b.rodzaj === 'sesja') return wyloguj();
    if (b.rodzaj === 'kod') return wymagajKodu();
    setDane((d) => ({ ...d, pobranie: { stan: d.faktury ? 'gotowe' : 'blad', blad: b.komunikat, bezSieci: b.rodzaj === 'polaczenie' } }));
  };

  /** Konto, firma, potem faktury i skrzynka; wynik tylko, jeśli w międzyczasie nic nie zaczęło się od nowa. */
  const laduj = async (u: string, wybrana?: string): Promise<void> => {
    const moje = ++pokolenie.current;
    const epoka = pamiec.epoka();
    const aktualne = () => pokolenie.current === moje;

    const k = await zapytajApi<KontoOdpowiedz>('konto');
    if (!aktualne()) return;
    if (!k.ok) return obsluzBlad(k.blad);
    setDane((d) => ({ ...d, konto: k.dane }));
    void pamiec.zapisz('konto', u, null, k.dane, epoka);
    void zapiszLogowanie().catch(() => undefined);

    const zapamietana = wybrana ?? (await ustawienia.wczytaj(kluczFirmy(u)).catch(() => null));
    if (!aktualne()) return;
    const firma = wybierzFirme(k.dane, zapamietana);
    if (!firma) {
      firmaPokazana.current = null;
      ostatnioUdane.current = Date.now();
      setDane((d) => ({ ...d, firmaId: null, faktury: PUSTA_LISTA, skrzynka: PUSTA_LISTA, zapisano: undefined, pobranie: { stan: 'gotowe', bezSieci: false } }));
      return;
    }

    // Inna firma niż na ekranie: najpierw jej dane z pamięci, nigdy dane poprzedniej.
    if (firmaPokazana.current !== firma) {
      const [f, s] = await Promise.all([pamiec.czytaj<Lista<Faktura>>('faktury', u, firma), pamiec.czytaj<Lista<FakturaKosztowa>>('skrzynka', u, firma)]);
      if (!aktualne()) return;
      firmaPokazana.current = firma;
      setDane((d) => ({ ...d, firmaId: firma, faktury: f?.dane, skrzynka: s?.dane, zapisano: f?.zapisano, pobranie: { ...d.pobranie, stan: f ? 'gotowe' : 'ladowanie' } }));
    }

    const [f, s] = await Promise.all([pobierzFaktury(firma), pobierzSkrzynke(firma)]);
    if (!aktualne()) return;
    const teraz = new Date().toISOString();
    setDane((d) => ({
      ...d,
      faktury: f.ok ? f.dane : d.faktury,
      skrzynka: s.ok ? s.dane : d.skrzynka,
      zapisano: f.ok && s.ok ? teraz : d.zapisano,
    }));
    if (f.ok) void pamiec.zapisz('faktury', u, firma, f.dane, epoka);
    if (s.ok) void pamiec.zapisz('skrzynka', u, firma, s.dane, epoka);
    const blad = !f.ok ? f.blad : !s.ok ? s.blad : undefined;
    if (blad) return obsluzBlad(blad);
    ostatnioUdane.current = Date.now();
    setDane((d) => ({ ...d, pobranie: { stan: 'gotowe', bezSieci: false } }));
  };

  // Start konta: dane z poprzedniego otwarcia od razu, potem z serwera.
  const poOdczycie = useEffectEvent((u: string, z: ZPamieci) => {
    if (z.konto) {
      if (z.firma) firmaPokazana.current = z.firma;
      setDane((d) => ({
        ...d,
        konto: z.konto,
        ...(z.firma
          ? { firmaId: z.firma, faktury: z.faktury?.dane, skrzynka: z.skrzynka?.dane, zapisano: z.faktury?.zapisano, pobranie: z.faktury ? { stan: 'gotowe', bezSieci: false } : d.pobranie }
          : {}),
      }));
    }
    void laduj(u);
  });

  useEffect(() => {
    if (!uzytkownik) return;
    firmaPokazana.current = undefined;
    ostatnioUdane.current = 0;
    let biezace = true;
    void odczytajPamiec(uzytkownik).then((z) => {
      if (biezace) poOdczycie(uzytkownik, z);
    });
    return () => {
      biezace = false;
      // Pobrania tego konta już nic nie zapiszą na ekranie.
      pokolenie.current += 1;
    };
  }, [uzytkownik]);

  // Powrót z tła: świeże dane, gdy ostatnie pobranie było dawno albo się nie udało.
  const poPowrocie = useEffectEvent(() => {
    if (!uzytkownik) return;
    const p = dane.pobranie;
    if (p.stan === 'blad' || p.bezSieci || Date.now() - ostatnioUdane.current > SWIEZE_MS) void laduj(uzytkownik);
  });
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') poPowrocie();
    });
    return () => sub.remove();
  }, []);

  // Sieć wróciła: po starcie bez sieci odświeżenie tokenu daje znać pierwsze; co 30 s próbujemy też sami.
  const poOdswiezeniuTokenu = useEffectEvent(() => {
    if (uzytkownik && (dane.pobranie.bezSieci || dane.pobranie.stan === 'blad')) void laduj(uzytkownik);
  });
  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((zdarzenie) => {
      // Poza blokadą `supabase-js`: wołanie klienta wewnątrz słuchacza czeka na samo siebie.
      if (zdarzenie === 'TOKEN_REFRESHED') setTimeout(() => poOdswiezeniuTokenu(), 0);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  const bezSieci = dane.pobranie.bezSieci;
  useEffect(() => {
    if (!bezSieci) return;
    const zegar = setInterval(() => {
      if (AppState.currentState === 'active') poOdswiezeniuTokenu();
    }, PONOW_BEZ_SIECI_MS);
    return () => clearInterval(zegar);
  }, [bezSieci]);

  const odswiez = async () => {
    if (!uzytkownik) return;
    setDane((d) => (d.pobranie.stan === 'blad' ? { ...d, pobranie: { stan: 'ladowanie', bezSieci: false } } : d));
    await laduj(uzytkownik);
  };

  const kontoFirmy: KontoFirmy = {
    konto: dane.konto,
    firma: dane.konto?.firmy.find((f) => f.id === dane.firmaId),
    wybierzFirme: (id) => {
      if (!uzytkownik || id === dane.firmaId) return;
      void ustawienia.zapisz(kluczFirmy(uzytkownik), id).catch(() => undefined);
      setDane((d) => ({ ...d, pobranie: { stan: 'ladowanie', bezSieci: false } }));
      void laduj(uzytkownik, id);
    },
  };

  const stanDanych: StanDanych = {
    zrodlo: 'baza',
    stan: dane.pobranie.stan,
    blad: dane.pobranie.blad,
    zapisano: dane.zapisano,
    bezSieci: dane.pobranie.bezSieci,
    fakturyPelne: dane.faktury?.pelna ?? true,
    skrzynkaPelna: dane.skrzynka?.pelna ?? true,
    odswiez,
  };

  // Zapisy na prawdziwych fakturach przyjdą z API (M8 wystawienie, M10 zapłata i reszta); do tego czasu strona.
  const zmiana = (wyzej: Stan): Stan => ({
    ...wyzej,
    dzis: dzienWarszawa(),
    dane: stanDanych,
    faktury: dane.faktury?.lista ?? [],
    skrzynka: dane.skrzynka?.lista ?? [],
    przelaczZaplate: (f) => naStronie('zaplata', f.id),
    dodajFakture: () => {
      naStronie('wystawienie');
      return '';
    },
    zastapFakture: (id) => naStronie('edycja', id),
    wyslijDoKsef: (id) => naStronie('wysylka', id),
    wrocDoSzkicu: (id) => naStronie('edycja', id),
    usunSzkic: (id) => naStronie('edycja', id),
  });

  return (
    <Kontekst value={kontoFirmy}>
      <PodmienStan zmiana={zmiana}>{children}</PodmienStan>
    </Kontekst>
  );
}
