/**
 * Sesja i blokada aplikacji (plan aplikacji 4.2, etap M5; przepływ w
 * WZORCE-MOBBIN.md, sekcja 7).
 *
 * M5a: dane przykładowe, bez serwera. Interfejs (`useSesja`) jest ten sam,
 * który w M5b dostanie Supabase (`signInWithPassword`, `mfa.verify`, sesja w
 * `expo-secure-store`) i `expo-local-authentication`; ekrany się nie zmienią.
 * Zasady danych przykładowych: hasło od 8 znaków przechodzi, krótsze daje błąd
 * złych danych; kod 2FA to dowolne 6 cyfr poza „000000”.
 *
 * Stany: `brak` (ekran logowania), `kod` (hasło przyjęte, czeka kod TOTP),
 * `propozycja` (zalogowany, raz pytamy o Face ID), `aktywna` (zakładki).
 * Blokada to osobna flaga nad aktywną sesją: aplikacja startuje zablokowana,
 * gdy klient ją włączył, i blokuje się po `BLOKADA_PO_MS` w tle.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';

import { CZLONKOWIE, FIRMA } from '@/dane-przykladowe/ustawienia';
import { useFlaga } from '@/stan/faktury';

export type StanSesji = 'brak' | 'kod' | 'propozycja' | 'aktywna';

/** Teksty błędów jak na stronie (`app/(auth)/login/page.tsx`, `two-factor/page.tsx`). */
export const BLEDY_LOGOWANIA = {
  puste_pola: 'Wpisz e-mail i hasło.',
  zle_dane: 'Nieprawidłowy e-mail lub hasło. Upewnij się, że e-mail jest potwierdzony.',
  google: 'Nie udało się zalogować przez Google. Spróbuj ponownie.',
  zly_kod: 'Kod nieprawidłowy. Sprawdź godzinę w telefonie i wpisz aktualny kod z aplikacji TOTP.',
  za_duzo_prob: 'Zbyt wiele prób. Poczekaj chwilę i spróbuj ponownie.',
  brak_polaczenia: 'Nie możemy się połączyć. Sprawdź internet i spróbuj ponownie.',
} as const;
export type KodBledu = keyof typeof BLEDY_LOGOWANIA;

/** Co ekran logowania robi po udanym kroku: kod 2FA, propozycja Face ID albo nic (zakładki pokazują się same). */
export type Wynik = { ok: true; dalej: 'kod' | 'propozycja' | 'gotowe' } | { ok: false; blad: KodBledu };

export type Biometria = { nazwa: string; twarz: boolean };
export type Konto = { email: string; imie: string; firma: string; metoda: 'haslo' | 'google' };

/** Po tylu minutach w tle aplikacja z włączoną blokadą prosi o Face ID. */
export const BLOKADA_PO_MS = 3 * 60 * 1000;

/** „Zaloguj przez Apple” (wytyczna App Store 4.8) włączamy w M11, z płatnym kontem Apple. */
export const APPLE_WLACZONE = false;

type Kontekst = {
  stan: StanSesji;
  konto?: Konto;
  /** E-mail z ostatniego logowania: po wylogowaniu stoi już w polu. */
  zapamietanyEmail: string;
  /** Biometria telefonu albo `undefined`, gdy jej nie ma. */
  biometria?: Biometria;
  /** Klient włączył blokadę Face ID (Więcej, Bezpieczeństwo). */
  blokada: boolean;
  ustawBlokade: (wlacz: boolean) => void;
  /** Aplikacja jest teraz zasłonięta ekranem blokady. */
  zablokowana: boolean;
  zaloguj: (email: string, haslo: string) => Promise<Wynik>;
  zalogujGoogle: () => Promise<Wynik>;
  potwierdzKod: (kod: string) => Promise<Wynik>;
  /** Powrót z ekranu kodu: hasło trzeba będzie wpisać znowu. */
  anulujKod: () => void;
  zakonczPropozycje: (wlacz: boolean) => void;
  /** Systemowe pytanie o Face ID. `sama`: wywołane przy pokazaniu blokady, nie przyciskiem. */
  odblokuj: (opcje?: { sama?: boolean }) => Promise<boolean>;
  wyloguj: () => void;
};

const SesjaKontekst = createContext<Kontekst | null>(null);

const BIOMETRIA_PRZYKLADOWA: Biometria = Platform.OS === 'ios' ? { nazwa: 'Face ID', twarz: true } : { nazwa: 'odcisk palca', twarz: false };

function kontoPrzykladowe(email?: string, metoda: Konto['metoda'] = 'haslo'): Konto {
  const ty = CZLONKOWIE.find((c) => c.ty) ?? CZLONKOWIE[0];
  return { email: email ?? ty.email, imie: ty.imie, firma: FIRMA.nazwa, metoda };
}

/** Czas odpowiedzi serwera w danych przykładowych, żeby było widać stan „trwa logowanie”. */
const czekaj = () => new Promise<void>((r) => setTimeout(r, 700));

export function Sesja({ children }: { children: ReactNode }) {
  const [dwaEtapy] = useFlaga('2fa', true);
  // Start na danych przykładowych: klient wraca do aplikacji z włączonym Face ID.
  const [stan, setStan] = useState<StanSesji>('aktywna');
  const [konto, setKonto] = useState<Konto | undefined>(() => kontoPrzykladowe());
  const [oczekujace, setOczekujace] = useState<Konto>();
  const [zapamietanyEmail, setZapamietanyEmail] = useState(() => kontoPrzykladowe().email);
  const [blokada, setBlokada] = useState(true);
  const [propozycjaPokazana, setPropozycjaPokazana] = useState(true);
  const [zablokowana, setZablokowana] = useState(true);
  const biometria = BIOMETRIA_PRZYKLADOWA;

  // Blokada po powrocie z tła; ref, żeby słuchacz AppState nie zależał od stanu.
  const wTle = useRef<number | undefined>(undefined);
  const czyBlokowac = useRef(false);
  useEffect(() => {
    czyBlokowac.current = stan === 'aktywna' && blokada;
  }, [stan, blokada]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') wTle.current = Date.now();
      if (s !== 'active') return;
      const od = wTle.current;
      wTle.current = undefined;
      if (od !== undefined && czyBlokowac.current && Date.now() - od >= BLOKADA_PO_MS) setZablokowana(true);
    });
    return () => sub.remove();
  }, []);

  const zakoncz = (k: Konto): Wynik => {
    setKonto(k);
    setOczekujace(undefined);
    setZablokowana(false);
    if (!propozycjaPokazana && !blokada && biometria) {
      setStan('propozycja');
      return { ok: true, dalej: 'propozycja' };
    }
    setStan('aktywna');
    return { ok: true, dalej: 'gotowe' };
  };

  const poHasle = (k: Konto): Wynik => {
    if (dwaEtapy) {
      setOczekujace(k);
      setStan('kod');
      return { ok: true, dalej: 'kod' };
    }
    return zakoncz(k);
  };

  const wartosc: Kontekst = {
    stan,
    konto,
    zapamietanyEmail,
    biometria,
    blokada,
    ustawBlokade: setBlokada,
    zablokowana: zablokowana && stan === 'aktywna' && blokada,
    zaloguj: async (email, haslo) => {
      const e = email.trim();
      if (!e || !haslo) return { ok: false, blad: 'puste_pola' };
      await czekaj();
      if (haslo.length < 8) return { ok: false, blad: 'zle_dane' };
      setZapamietanyEmail(e);
      return poHasle(kontoPrzykladowe(e, 'haslo'));
    },
    zalogujGoogle: async () => {
      // M5b: `signInWithOAuth` i `WebBrowser.openAuthSessionAsync` z powrotem na `faktway://`.
      await czekaj();
      const k = kontoPrzykladowe(undefined, 'google');
      setZapamietanyEmail(k.email);
      return poHasle(k);
    },
    potwierdzKod: async (kod) => {
      if (!/^\d{6}$/.test(kod)) return { ok: false, blad: 'zly_kod' };
      await czekaj();
      if (kod === '000000') return { ok: false, blad: 'zly_kod' };
      return zakoncz(oczekujace ?? kontoPrzykladowe());
    },
    anulujKod: () => {
      setOczekujace(undefined);
      setStan('brak');
    },
    zakonczPropozycje: (wlacz) => {
      setPropozycjaPokazana(true);
      setBlokada(wlacz);
      setStan('aktywna');
    },
    odblokuj: async (opcje) => {
      // M5b: `LocalAuthentication.authenticateAsync`. Bez niego samo pokazanie
      // blokady zachowuje się jak anulowane pytanie systemu: zostaje ekran z
      // przyciskiem „Odblokuj”, który w danych przykładowych zawsze przechodzi.
      if (opcje?.sama) return false;
      setZablokowana(false);
      return true;
    },
    wyloguj: () => {
      // Blokada należy do sesji na tym telefonie: po ponownym logowaniu
      // zapytamy o nią jeszcze raz (ekran propozycji).
      setStan('brak');
      setKonto(undefined);
      setOczekujace(undefined);
      setZablokowana(false);
      setBlokada(false);
      setPropozycjaPokazana(false);
    },
  };

  return <SesjaKontekst.Provider value={wartosc}>{children}</SesjaKontekst.Provider>;
}

export function useSesja(): Kontekst {
  const k = useContext(SesjaKontekst);
  if (!k) throw new Error('useSesja poza <Sesja>');
  return k;
}

/** Pierwsze imię do powitania („Dzień dobry, Jan”). */
export function imieDoPowitania(konto?: Konto): string {
  return konto?.imie.split(' ')[0] ?? '';
}
