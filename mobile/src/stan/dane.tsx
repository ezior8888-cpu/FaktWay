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
 * - Od M8 szybka faktura (`POST /faktury`, z kluczem zapisu) i wysyłka szkicu
 *   (`POST /faktury/{id}/wysylka`). Nowa faktura od razu stoi na liście, a
 *   wysłane z telefonu odświeżamy co kilka sekund, aż KSeF przyjmie albo odrzuci
 *   (wibracja „sukces” albo „błąd”, ZASADY-DESIGNU.md, sekcja 7).
 *
 * Dane należą do jednego konta: zmiana konta albo wylogowanie zeruje je w
 * pamięci od razu (przy rysowaniu, zanim cokolwiek się pokaże), a pobrania
 * zaczęte wcześniej przepadają (`pokolenie`). Pliki czyści sesja przy
 * wylogowaniu (`stan/sesja.tsx`).
 *
 * Na danych przykładowych (bez adresu bazy) ten dostawca nic nie robi.
 */
import * as Haptics from 'expo-haptics';
import { createContext, use, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { Faktura, FakturaKosztowa } from '@/dane-przykladowe';
import { naStronie } from '@/komponenty/na-stronie';
import { bezDlugichMyslnikow, type BladApi } from '@/lib/api/bledy';
import type {
  FirmaKonta,
  KontoOdpowiedz,
  PodpowiedzFakturyOdpowiedz,
  SesjaOdpowiedz,
  WystawienieOdpowiedz,
  WysylkaSzkicuOdpowiedz,
} from '@/lib/api/kontrakt';
import { zapytajApi } from '@/lib/api/polaczenie';
import { dzienWarszawa, statusZBazy } from '@/lib/dane/mapowanie';
import { pamiec } from '@/lib/dane/pamiec-plikow';
import { pobierzFaktury, pobierzSkrzynke } from '@/lib/dane/zapytania';
import { daneTokenu } from '@/lib/logowanie/token';
import { supabase, ustawienia } from '@/lib/supabase';
import { PodmienStan, type Stan, type StanDanych, type WynikZapisu } from '@/stan/faktury';
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

/** Faktura wysłana z telefonu: status z bazy co tyle, aż KSeF przyjmie albo odrzuci. */
const STATUS_KSEF_CO_MS = 3000;
/** Najwyżej tyle sprawdzeń (około 3 minuty); potem status odświeży pociągnięcie listy. */
const STATUS_KSEF_PROB = 60;

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

/** Podpowiedź do pustego formularza faktury (M8): numer, dziś, zwolnienie z VAT; `gotowe` po odpowiedzi serwera. */
export type PodpowiedzFaktury = { gotowe: boolean; numer?: string; dzis?: string; zwolnienieVat: boolean };

/**
 * `GET /faktury/podpowiedz` dla wybranej firmy, raz na otwarcie formularza.
 * Na danych przykładowych i bez sieci: `gotowe` bez numeru (klient wpisze go sam).
 */
export function usePodpowiedzFaktury(): PodpowiedzFaktury {
  const kontekst = use(Kontekst);
  const firma = kontekst?.firma?.id;
  // Dane przykładowe (bez kontekstu konta): od razu gotowe. Prawdziwe konto czeka na firmę z `GET /konto`.
  const [podpowiedz, setPodpowiedz] = useState<PodpowiedzFaktury>({ gotowe: kontekst === null, zwolnienieVat: false });
  useEffect(() => {
    if (!firma) return;
    let biezace = true;
    void zapytajApi<PodpowiedzFakturyOdpowiedz>('faktury/podpowiedz', { firma }).then((w) => {
      if (!biezace) return;
      setPodpowiedz(w.ok ? { gotowe: true, numer: w.dane.numer ?? undefined, dzis: w.dane.dzis, zwolnienieVat: w.dane.zwolnienieVat } : { gotowe: true, zwolnienieVat: false });
    });
    return () => {
      biezace = false;
    };
  }, [firma]);
  return podpowiedz;
}

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
  /** Takt sprawdzania statusu KSeF: zegar uzbraja się od nowa także wtedy, gdy pobranie się nie udało. */
  const [takt, setTakt] = useState(0);
  const ostatnioUdane = useRef(0);
  const firmaPokazana = useRef<string | null | undefined>(undefined);
  /** Faktury wysłane z telefonu w tej sesji, których wynik w KSeF śledzimy. */
  const sledzone = useRef(new Map<string, number>());

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
    // Wybór z Więcej zostaje na telefonie dopiero, gdy serwer potwierdził firmę na liście konta.
    if (wybrana && firma === wybrana) void ustawienia.zapisz(kluczFirmy(u), wybrana).catch(() => undefined);
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

  /** Sama lista faktur wybranej firmy (po zapisie i przy śledzeniu statusu KSeF). */
  const odswiezFaktury = async (): Promise<void> => {
    const firma = firmaPokazana.current;
    if (!uzytkownik || !firma) return;
    const moje = pokolenie.current;
    const epoka = pamiec.epoka();
    const f = await pobierzFaktury(firma);
    if (pokolenie.current !== moje || firmaPokazana.current !== firma || !f.ok) return;
    setDane((d) => ({ ...d, faktury: f.dane }));
    void pamiec.zapisz('faktury', uzytkownik, firma, f.dane, epoka);
  };

  // Wynik KSeF faktur wysłanych z telefonu: co kilka sekund, póki są w drodze.
  const sprawdzWysylane = useEffectEvent(() => {
    const lista = dane.faktury?.lista ?? [];
    let wDrodze = false;
    for (const [id, proby] of sledzone.current) {
      const f = lista.find((x) => x.id === id);
      if (f && f.statusKsef !== 'wysylanie') {
        sledzone.current.delete(id);
        if (f.statusKsef === 'przyjeta') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        else if (f.statusKsef === 'odrzucona' || f.statusKsef === 'blad') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        continue;
      }
      if (proby >= STATUS_KSEF_PROB) {
        sledzone.current.delete(id);
        continue;
      }
      sledzone.current.set(id, proby + 1);
      wDrodze = true;
    }
    if (wDrodze) void odswiezFaktury().finally(() => setTakt((t) => t + 1));
  });
  const fakturyTeraz = dane.faktury;
  useEffect(() => {
    if (sledzone.current.size === 0) return;
    const zegar = setTimeout(() => sprawdzWysylane(), STATUS_KSEF_CO_MS);
    return () => clearTimeout(zegar);
  }, [fakturyTeraz, takt]);

  /** Błąd sesji z zapisu: te same reakcje co przy pobieraniu; zdanie wraca do formularza. */
  const bladZapisu = (b: BladApi): WynikZapisu => {
    if (b.rodzaj === 'sesja') wyloguj();
    else if (b.rodzaj === 'kod') wymagajKodu();
    // Firma bez dostępu: konto i lista firm od nowa, jak przy pobieraniu.
    else if (b.rodzaj === 'firma' && uzytkownik) void laduj(uzytkownik);
    return { ok: false, komunikat: b.komunikat, ...(b.pole ? { pole: b.pole } : {}) };
  };

  /** Faktura z serwera od razu na liście (szczegół ją widzi), potem lista od nowa w tle. */
  const pokazZapisana = (f: Faktura, zapisana: { id: string; numer: string; ksefStatus: string }) => {
    const statusKsef = statusZBazy(zapisana.ksefStatus);
    setDane((d) => {
      const lista = (d.faktury?.lista ?? []).filter((x) => x.id !== zapisana.id);
      const stara = d.faktury?.lista.find((x) => x.id === zapisana.id);
      return { ...d, faktury: { lista: [{ ...(stara ?? f), id: zapisana.id, numer: zapisana.numer, statusKsef }, ...lista], pelna: d.faktury?.pelna ?? true } };
    });
    if (statusKsef === 'wysylanie') sledzone.current.set(zapisana.id, 0);
    void odswiezFaktury();
  };

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

  // Wystawienie i wysyłka szkicu przez API (M8); zapłata, edycja i reszta zapisów do M10 na stronie.
  const zmiana = (wyzej: Stan): Stan => ({
    ...wyzej,
    dzis: dzienWarszawa(),
    dane: stanDanych,
    faktury: dane.faktury?.lista ?? [],
    skrzynka: dane.skrzynka?.lista ?? [],
    przelaczZaplate: (f) => naStronie('zaplata', f.id),
    dodajFakture: async (f, wyslij, naKoncie) => {
      const firma = dane.firmaId;
      if (!naKoncie || !firma) {
        naStronie('wystawienie');
        return { ok: false, komunikat: 'Tę fakturę wystawisz na faktway.pl.' };
      }
      const w = await zapytajApi<WystawienieOdpowiedz>('faktury', {
        metoda: 'POST',
        firma,
        klucz: naKoncie.klucz,
        cialo: { wyslij, faktura: naKoncie.faktura },
      });
      if (!w.ok) return bladZapisu(w.blad);
      // Stawka bez procentu („zw”, „oo”, „np”) od razu z opisem, nie jako 0% modelu formularza.
      const linie = naKoncie.faktura.lines;
      const zOpisem = { ...f, pozycje: f.pozycje.map((p, i) => (linie[i] && !/^\d+$/.test(linie[i].vatRate) ? { ...p, stawkaOpis: linie[i].vatRate } : p)) };
      pokazZapisana(zOpisem, w.dane.faktura);
      return { ok: true, id: w.dane.faktura.id, ...(w.dane.wysylka?.blad ? { uwaga: bezDlugichMyslnikow(w.dane.wysylka.blad) } : {}) };
    },
    zastapFakture: (id) => naStronie('edycja', id),
    wyslijDoKsef: async (id) => {
      const firma = dane.firmaId;
      const f = dane.faktury?.lista.find((x) => x.id === id);
      // Odrzucona albo z błędem wysyłki: poprawka i ponowna wysyłka na stronie (M10).
      if (!firma || !f || f.statusKsef !== 'robocza') {
        naStronie('wysylka', id);
        return { ok: false, komunikat: 'Tę fakturę wyślesz ponownie na faktway.pl.' };
      }
      const w = await zapytajApi<WysylkaSzkicuOdpowiedz>(`faktury/${id}/wysylka`, { metoda: 'POST', firma });
      if (!w.ok) return bladZapisu(w.blad);
      pokazZapisana(f, w.dane.faktura);
      return { ok: true, id };
    },
    wrocDoSzkicu: (id) => naStronie('edycja', id),
    usunSzkic: (id) => naStronie('edycja', id),
  });

  return (
    <Kontekst value={kontoFirmy}>
      <PodmienStan zmiana={zmiana}>{children}</PodmienStan>
    </Kontekst>
  );
}
