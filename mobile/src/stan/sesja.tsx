/**
 * Sesja i blokada aplikacji (plan aplikacji 4.2, etapy M5a i M5b; przepływ w
 * WZORCE-MOBBIN.md, sekcja 7).
 *
 * Stany: `wczytywanie` (start, ekran startowy systemu czeka na sesję z pęku
 * kluczy), `brak` (logowanie), `kod` (pierwszy krok przyjęty, czeka kod TOTP),
 * `propozycja` (zalogowany, raz pytamy o Face ID), `aktywna` (zakładki).
 * Blokada to osobna flaga nad aktywną sesją: aplikacja startuje zablokowana,
 * gdy klient ją włączył, i blokuje się po `BLOKADA_PO_MS` w tle.
 *
 * Serwer i telefon obsługuje zaplecze (`lib/logowanie/`): Supabase, gdy
 * aplikacja ma adres bazy, inaczej dane przykładowe z M5a. Ekrany widzą tylko
 * `useSesja`.
 *
 * Koniec sesji (wylogowanie, „Zaloguj się na inne konto”, serwer odrzucił
 * sesję) czyści dane poprzedniego konta: stan w pamięci (`wyczysc` w
 * `stan/faktury.tsx`; dane z bazy trzyma `stan/dane.tsx` pod kluczem konta)
 * i dane z poprzedniego otwarcia w plikach (`lib/dane/pamiec-plikow.ts`).
 */
import { createContext, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { pamiec } from '@/lib/dane/pamiec-plikow';
import { zapleczePrzykladowe } from '@/lib/logowanie/przykladowe';
import { zapleczeSupabase } from '@/lib/logowanie/supabase';
import { BLEDY_LOGOWANIA, type Biometria, type KodBledu, type Konto, type WynikKroku, type Zaplecze } from '@/lib/logowanie/typy';
import { supabase } from '@/lib/supabase';
import { useFlaga, useStanFaktur } from '@/stan/faktury';

export { BLEDY_LOGOWANIA, type Biometria, type KodBledu, type Konto };

export type StanSesji = 'wczytywanie' | 'brak' | 'kod' | 'propozycja' | 'aktywna';

/** Co ekran logowania robi po udanym kroku: kod 2FA, propozycja Face ID albo nic (zakładki pokazują się same). */
export type Wynik = { ok: true; dalej: 'kod' | 'propozycja' | 'gotowe' } | { ok: false; blad: KodBledu };

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
  /** Włączenie najpierw pyta system o Face ID (zgoda systemu i próba); wyłączenie od razu. */
  ustawBlokade: (wlacz: boolean) => Promise<void>;
  /** Aplikacja jest teraz zasłonięta ekranem blokady. */
  zablokowana: boolean;
  /**
   * Aplikacja sama pyta system o Face ID. Pytanie robi ją „nieaktywną” jak
   * przełącznik aplikacji, ale wtedy zasłona nie może zakryć ekranu.
   */
  pytanieSystemu: boolean;
  zaloguj: (email: string, haslo: string) => Promise<Wynik>;
  zalogujGoogle: () => Promise<Wynik>;
  potwierdzKod: (kod: string) => Promise<Wynik>;
  /** Powrót z ekranu kodu: hasło trzeba będzie wpisać znowu. */
  anulujKod: () => void;
  zakonczPropozycje: (wlacz: boolean) => Promise<void>;
  /** Potwierdzenie tożsamości twarzą przed akcją wrażliwą (usunięcie konta z Google bez 2FA). */
  potwierdzBiometria: () => Promise<boolean>;
  /** Systemowe pytanie o Face ID. `sama`: wywołane przy pokazaniu blokady, nie przyciskiem. */
  odblokuj: (opcje?: { sama?: boolean }) => Promise<boolean>;
  wyloguj: () => void;
  /**
   * API odpowiedziało `mfa_required`: konto ma teraz 2FA (włączone np. na
   * komputerze), a ta sesja nie ma kodu. Ekran kodu, bez wylogowania.
   */
  wymagajKodu: () => void;
};

const SesjaKontekst = createContext<Kontekst | null>(null);

/** Klucze ustawień tego telefonu (pęk kluczy albo pamięć danych przykładowych). */
const KLUCZ = { blokada: 'blokada', propozycja: 'propozycja-face-id', email: 'email' } as const;

export function Sesja({ children }: { children: ReactNode }) {
  // Dane przykładowe: o kodzie 2FA decyduje przełącznik z Więcej, Bezpieczeństwo; na prawdziwym koncie serwer.
  const [dwaEtapyPrzykladowe] = useFlaga('2fa', true);
  const { wyczysc: wyczyscStan } = useStanFaktur();
  const [zaplecze] = useState<Zaplecze>(() => (supabase ? zapleczeSupabase(supabase) : zapleczePrzykladowe()));

  /** Dane poprzedniego konta znikają z pamięci i z plików telefonu. */
  const wyczyscDane = () => {
    wyczyscStan();
    void pamiec.wyczysc().catch(() => undefined);
  };
  const poKoncuSesji = useEffectEvent(wyczyscDane);

  const [stan, setStan] = useState<StanSesji>('wczytywanie');
  const [konto, setKonto] = useState<Konto>();
  const [oczekujace, setOczekujace] = useState<Konto>();
  const [zapamietanyEmail, setZapamietanyEmail] = useState('');
  const [biometria, setBiometria] = useState<Biometria>();
  const [blokada, setBlokada] = useState(false);
  const [propozycjaPokazana, setPropozycjaPokazana] = useState(false);
  const [zablokowana, setZablokowana] = useState(false);
  const [pytanieSystemu, setPytanieSystemu] = useState(false);

  const zapytajSystem = async (sama: boolean) => {
    setPytanieSystemu(true);
    try {
      return await zaplecze.odblokuj({ sama });
    } finally {
      setPytanieSystemu(false);
    }
  };

  // Start: sesja i ustawienia z telefonu. Do końca widać ekran startowy systemu (`app/_layout.tsx`).
  useEffect(() => {
    let aktualne = true;
    void (async () => {
      const [k, bio, b, p, e] = await Promise.all([
        zaplecze.start().catch(() => undefined),
        zaplecze.biometria().catch(() => undefined),
        zaplecze.wczytaj(KLUCZ.blokada).catch(() => null),
        zaplecze.wczytaj(KLUCZ.propozycja).catch(() => null),
        zaplecze.wczytaj(KLUCZ.email).catch(() => null),
      ]);
      if (!aktualne) return;
      const zBlokada = b === '1' && bio !== undefined;
      setBiometria(bio);
      setBlokada(zBlokada);
      setPropozycjaPokazana(p === '1');
      setZapamietanyEmail(e ?? '');
      setKonto(k);
      setZablokowana(k !== undefined && zBlokada);
      setStan(k ? 'aktywna' : 'brak');
    })();
    return () => {
      aktualne = false;
    };
  }, [zaplecze]);

  // Serwer zakończył sesję sam (odebrany dostęp, nieważny token): wracamy do logowania.
  useEffect(
    () =>
      zaplecze.poWylogowaniu(() => {
        setKonto(undefined);
        setOczekujace(undefined);
        setZablokowana(false);
        setStan((s) => (s === 'wczytywanie' ? s : 'brak'));
        poKoncuSesji();
      }),
    [zaplecze],
  );

  // Blokada po powrocie z tła i odświeżanie tokenu tylko na wierzchu; ref, żeby słuchacz nie zależał od stanu.
  const wTle = useRef<number | undefined>(undefined);
  const czyBlokowac = useRef(false);
  useEffect(() => {
    czyBlokowac.current = stan === 'aktywna' && blokada;
  }, [stan, blokada]);
  useEffect(() => {
    zaplecze.naWierzchu(AppState.currentState === 'active');
    const sub = AppState.addEventListener('change', (s) => {
      zaplecze.naWierzchu(s === 'active');
      if (s === 'background') wTle.current = Date.now();
      if (s !== 'active') return;
      const od = wTle.current;
      wTle.current = undefined;
      if (od !== undefined && czyBlokowac.current && Date.now() - od >= BLOKADA_PO_MS) setZablokowana(true);
    });
    return () => sub.remove();
  }, [zaplecze]);

  const zapiszBlokade = (wlacz: boolean) => {
    setBlokada(wlacz);
    void zaplecze.zapisz(KLUCZ.blokada, wlacz ? '1' : '0');
  };

  /** Blokadę włącza dopiero udane Face ID: system pyta wtedy o zgodę, a klient widzi, że działa. */
  const wlaczBlokade = async (wlacz: boolean) => {
    if (wlacz && !(await zapytajSystem(false))) return;
    zapiszBlokade(wlacz);
  };

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

  const poPierwszymKroku = (w: WynikKroku, email: string): Wynik => {
    if (!w.ok) return w;
    setZapamietanyEmail(email);
    void zaplecze.zapisz(KLUCZ.email, email);
    if (w.wymagaKodu && (supabase !== null || dwaEtapyPrzykladowe)) {
      setOczekujace(w.konto);
      setStan('kod');
      return { ok: true, dalej: 'kod' };
    }
    return zakoncz(w.konto);
  };

  const wartosc: Kontekst = {
    stan,
    konto,
    zapamietanyEmail,
    biometria,
    blokada,
    ustawBlokade: wlaczBlokade,
    zablokowana: zablokowana && stan === 'aktywna' && blokada,
    pytanieSystemu,
    zaloguj: async (email, haslo) => {
      const e = email.trim();
      if (!e || !haslo) return { ok: false, blad: 'puste_pola' };
      return poPierwszymKroku(await zaplecze.zaloguj(e, haslo), e);
    },
    zalogujGoogle: async () => {
      const w = await zaplecze.zalogujGoogle();
      return poPierwszymKroku(w, w.ok ? w.konto.email : zapamietanyEmail);
    },
    potwierdzKod: async (kod) => {
      if (!/^\d{6}$/.test(kod)) return { ok: false, blad: 'zly_kod' };
      const w = await zaplecze.potwierdzKod(kod);
      if (!w.ok) return w;
      return zakoncz(oczekujace ?? w.konto);
    },
    anulujKod: () => {
      setOczekujace(undefined);
      setStan('brak');
      void zaplecze.anulujKod();
    },
    zakonczPropozycje: async (wlacz) => {
      // Anulowane Face ID zostawia klienta na propozycji: może spróbować znowu albo wybrać „Nie teraz”.
      if (wlacz && !(await zapytajSystem(false))) return;
      setPropozycjaPokazana(true);
      void zaplecze.zapisz(KLUCZ.propozycja, '1');
      zapiszBlokade(wlacz);
      setStan('aktywna');
    },
    potwierdzBiometria: () => zapytajSystem(false),
    odblokuj: async (opcje) => {
      const ok = await zapytajSystem(Boolean(opcje?.sama));
      if (ok) setZablokowana(false);
      return ok;
    },
    wyloguj: () => {
      // Blokada należy do sesji na tym telefonie: po ponownym logowaniu
      // zapytamy o nią jeszcze raz (ekran propozycji).
      setStan('brak');
      setKonto(undefined);
      setOczekujace(undefined);
      setZablokowana(false);
      zapiszBlokade(false);
      setPropozycjaPokazana(false);
      void zaplecze.zapisz(KLUCZ.propozycja, '0');
      wyczyscDane();
      void zaplecze.wyloguj();
    },
    wymagajKodu: () => {
      if (stan !== 'aktywna' || !konto) return;
      setOczekujace(konto);
      setZablokowana(false);
      setStan('kod');
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
