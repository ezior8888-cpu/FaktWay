/**
 * Stan wspólny dla wszystkich ekranów: faktury (zapłata, nowe, wysyłka do
 * KSeF, usunięcie szkicu), skrzynka KSeF, faktury cykliczne, wydatki i proste
 * przełączniki ustawień.
 *
 * Ten dostawca trzyma dane przykładowe. Na prawdziwym koncie (od M7)
 * `DaneKonta` (`stan/dane.tsx`) podmienia faktury i skrzynkę KSeF na dane z
 * bazy przez `PodmienStan`. Wystawienie zwykłej faktury i wysyłka szkicu idą
 * od M8 przez API, od M9 wydatki (lista z bazy, wydatek ze zdjęcia, opis
 * kosztu); reszta zapisów odsyła na faktway.pl do M10.
 *
 * Wydatek ze zdjęcia na danych przykładowych: wgranie i odczyt trwają chwilę
 * i dają zawsze ten sam paragon (`ROZPOZNANY`), jak na stronie w trybie E2E.
 */
import * as Haptics from 'expo-haptics';
import { createContext, use, useMemo, useRef, useState, type ReactNode } from 'react';
import { Share } from 'react-native';

import { DZIS, FAKTURY, KOSZTY, skrzynkaPrzykladowa, type Faktura, type FakturaKosztowa, type Koszt } from '@/dane-przykladowe';
import { CYKLICZNE, type FakturaCykliczna } from '@/dane-przykladowe/kontrahenci';
import type { FakturaTelefonu } from '@/lib/api/kontrakt';
import { kwota } from '@/lib/format';
import type { FormularzWydatku, StanOdczytuTelefonu } from '@/lib/wydatek/zatwierdzenie';

/**
 * Wynik zapisu faktury. `uwaga`: zapis się udał, ale coś zostało do zrobienia
 * (np. szkic zapisany, a kolejka KSeF odmówiła). `pole`: pole formularza z błędem
 * serwera (`buyerName`, `lines.0.name`).
 */
export type WynikZapisu = { ok: true; id: string; uwaga?: string } | { ok: false; komunikat: string; pole?: string };

/** Zapis na prawdziwym koncie (M8): treść dla `POST /faktury` i klucz jednego wypełnienia formularza. */
export type ZapisNaKoncie = { faktura: FakturaTelefonu; klucz: string };

/** Plik dokumentu kosztu do wgrania (M9): skan albo zdjęcie z galerii, w plikach aplikacji. */
export type PlikDokumentu = { uri: string; nazwa: string; typ: string };

/**
 * Wynik wgrania zdjęcia kosztu. `ponow`: nie wiadomo, czy dotarło (sieć,
 * przerwa); ponowienie z tym samym kluczem nie zleci drugiego odczytu.
 */
export type WynikWgrania = { ok: true; odczytId: string } | { ok: false; komunikat: string; ponow: boolean };

/**
 * Skąd są faktury i skrzynka KSeF na ekranie i w jakim są stanie. Dane
 * przykładowe są zawsze gotowe; dane z bazy mają ładowanie, błąd i datę.
 */
export type StanDanych = {
  zrodlo: 'przyklad' | 'baza';
  stan: 'ladowanie' | 'gotowe' | 'blad';
  /** Zdanie dla klienta, gdy ostatnie pobranie się nie udało. */
  blad?: string;
  /** Kiedy pobrano to, co widać (ISO); stare dane pokazujemy z tą datą. */
  zapisano?: string;
  /** Ostatnie pobranie nie doszło do serwera: widać dane z poprzedniego otwarcia. */
  bezSieci: boolean;
  /** Lista ma limit (200 najnowszych): reszta na faktway.pl. */
  fakturyPelne: boolean;
  skrzynkaPelna: boolean;
  /** Wydatki (M9): 200 najnowszych według daty dokumentu. */
  wydatkiPelne: boolean;
  odswiez: () => Promise<void>;
};

export type Stan = {
  /** Dziś (RRRR-MM-DD): data przykładowa albo dzień w Warszawie dla danych z bazy. */
  dzis: string;
  dane: StanDanych;
  faktury: Faktura[];
  skrzynka: FakturaKosztowa[];
  /** Oznacza albo cofa zapłatę (z wibracją i paskiem „Cofnij”); jedno miejsce dla gestu, menu i przycisku. */
  przelaczZaplate: (f: Faktura) => void;
  /**
   * Dodaje fakturę; `wyslij` to „Wyślij do KSeF” (na danych przykładowych przyjęcie po chwili).
   * Na prawdziwym koncie zapis idzie przez API z `naKoncie` (M8).
   */
  dodajFakture: (f: Faktura, wyslij: boolean, naKoncie?: ZapisNaKoncie) => Promise<WynikZapisu>;
  /** Zapisuje poprawiony szkic albo odrzuconą fakturę w miejscu starej; `wyslij` jak w `dodajFakture`. */
  zastapFakture: (id: string, f: Faktura, wyslij: boolean) => void;
  /** Faktura właśnie wysłana z formularza: jej szczegół pokazuje kartę „Wysyłamy do KSeF” → „Przyjęta w KSeF”. */
  potwierdzenie: string | undefined;
  /** Pasek „Cofnij” nad zakładkami (`PasekCofnij`): co się stało i jak to odwrócić. */
  cofnij: { id: number; tekst: string; akcja: () => void } | undefined;
  pokazCofnij: (c: { tekst: string; akcja: () => void } | undefined) => void;
  pokazPotwierdzenie: (id: string | undefined) => void;
  /** Wysyła szkic albo odrzuconą fakturę ponownie do KSeF (na prawdziwym koncie szkic przez API, M8). */
  wyslijDoKsef: (id: string) => Promise<WynikZapisu>;
  /** Cofa odrzuconą fakturę do szkicu. */
  wrocDoSzkicu: (id: string) => void;
  usunSzkic: (id: string) => void;
  cykliczne: FakturaCykliczna[];
  zapiszCykliczna: (c: FakturaCykliczna) => void;
  usunCykliczna: (id: string) => void;
  koszty: Koszt[];
  /** Dodaje wydatek wpisany ręcznie (dane przykładowe; na koncie odsyła na faktway.pl do M10). Zwraca id. */
  zapiszKoszt: (k: Koszt) => string;
  usunKoszt: (id: string) => void;
  /**
   * Wgrywa zdjęcie albo PDF kosztu i zleca odczyt (M9). `klucz` jeden na zdjęcie:
   * ponowienie po zerwanym połączeniu oddaje to samo zadanie, bez drugiego kosztu.
   */
  wgrajDokument: (plik: PlikDokumentu, klucz: string) => Promise<WynikWgrania>;
  /** Jedno pytanie o stan odczytu (`czekajNaOdczyt` pyta co 2 s). */
  stanOdczytu: (odczytId: string) => Promise<StanOdczytuTelefonu>;
  /** Lista wydatków od nowa (po odczycie, żeby szczegół widział nowy wydatek). */
  odswiezWydatki: () => Promise<void>;
  /** Opis i akceptacja wydatku z formularza (na koncie `POST /wydatki/{id}/zatwierdzenie`, M9). */
  zatwierdzKoszt: (k: Koszt, f: FormularzWydatku) => Promise<WynikZapisu>;
  /** Proste przełączniki ekranów ustawień i list (np. wstrzymane przypomnienia). */
  flagi: Record<string, boolean>;
  ustawFlage: (klucz: string, wartosc: boolean) => void;
  /** Wylogowanie i zmiana konta: wszystko wraca do stanu z uruchomienia aplikacji. */
  wyczysc: () => void;
};

const Kontekst = createContext<Stan | null>(null);

/** Czas „przyjęcia w KSeF” na danych przykładowych. */
const CZAS_KSEF_MS = 2500;

/** Wgranie i odczyt zdjęcia na danych przykładowych. */
const CZAS_WGRANIA_MS = 700;
const CZAS_ODCZYTU_MS = 1200;

/** Odczyt przykładowego paragonu (na stronie: OCR, `use-expense-capture.tsx`). */
const ROZPOZNANY: Omit<Koszt, 'id'> = {
  dostawca: 'Stacja Paliw Rondo',
  nip: '1234567890',
  opis: '',
  data: DZIS,
  netto: 16_260,
  vat: 3_740,
  brutto: 20_000,
  zrodlo: 'zdjecie',
  doOpisania: true,
  kategoria: 'Paliwo',
  kolumna: '13',
  dokument: 'Paragon',
  numer: '0051/2026',
  wKpir: true,
};

const poczekaj = (ms: number) => new Promise<void>((gotowe) => setTimeout(gotowe, ms));

function numerKsef(f: Faktura): string {
  return `${f.nipKontrahenta}-${f.dataWystawienia.replaceAll('-', '')}-${f.id.toUpperCase().padStart(6, '0')}-A1`;
}

export function StanFaktur({ children }: { children: ReactNode }) {
  const [faktury, setFaktury] = useState<Faktura[]>(FAKTURY);
  const [cykliczne, setCykliczne] = useState<FakturaCykliczna[]>(CYKLICZNE);
  const [flagi, setFlagi] = useState<Record<string, boolean>>({});
  const [koszty, setKoszty] = useState<Koszt[]>(KOSZTY);
  const [potwierdzenie, setPotwierdzenie] = useState<string>();
  const [cofnij, setCofnij] = useState<Stan['cofnij']>();
  const licznik = useRef(0);
  const zegary = useRef(new Set<ReturnType<typeof setTimeout>>());
  /** Odczyty przykładowe: kiedy wgrane i jaki wydatek dały. */
  const odczyty = useRef(new Map<string, { od: number; wydatekId?: string }>());

  const wartosc = useMemo<Stan>(() => {
    const zmien = (id: string, zmiana: Partial<Faktura>) =>
      setFaktury((lista) => lista.map((f) => (f.id === id ? { ...f, ...zmiana } : f)));

    const przyjmijPoChwili = (id: string) => {
      const zegar = setTimeout(() => {
        zegary.current.delete(zegar);
        setFaktury((lista) =>
          lista.map((f) =>
            f.id === id && f.statusKsef === 'wysylanie' ? { ...f, statusKsef: 'przyjeta', numerKsef: numerKsef(f), blad: undefined } : f,
          ),
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }, CZAS_KSEF_MS);
      zegary.current.add(zegar);
    };

    return {
      dzis: DZIS,
      dane: {
        zrodlo: 'przyklad',
        stan: 'gotowe',
        bezSieci: false,
        fakturyPelne: true,
        skrzynkaPelna: true,
        wydatkiPelne: true,
        // Dane przykładowe: odświeżenie tylko pokazuje kręciołek.
        odswiez: () => new Promise<void>((gotowe) => setTimeout(gotowe, 800)),
      },
      faktury,
      skrzynka: skrzynkaPrzykladowa(koszty),
      przelaczZaplate: (f) => {
        zmien(f.id, { zaplacona: !f.zaplacona });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setCofnij({
          id: Date.now(),
          tekst: f.zaplacona ? `Bez zapłaty: ${f.numer}` : `Zapłacona: ${f.numer}`,
          akcja: () => zmien(f.id, { zaplacona: f.zaplacona }),
        });
      },
      dodajFakture: (f, wyslij) => {
        licznik.current += 1;
        const id = `n${licznik.current}`;
        setFaktury((lista) => [{ ...f, id, statusKsef: wyslij ? 'wysylanie' : 'robocza' }, ...lista]);
        if (wyslij) przyjmijPoChwili(id);
        return Promise.resolve({ ok: true, id });
      },
      zastapFakture: (id, f, wyslij) => {
        setFaktury((lista) => lista.map((x) => (x.id === id ? { ...f, id, statusKsef: wyslij ? 'wysylanie' : 'robocza', blad: undefined } : x)));
        if (wyslij) przyjmijPoChwili(id);
      },
      potwierdzenie,
      pokazPotwierdzenie: setPotwierdzenie,
      cofnij,
      pokazCofnij: (c) => setCofnij(c ? { ...c, id: Date.now() } : undefined),
      wyslijDoKsef: (id) => {
        zmien(id, { statusKsef: 'wysylanie', blad: undefined });
        przyjmijPoChwili(id);
        return Promise.resolve({ ok: true, id });
      },
      wrocDoSzkicu: (id) => zmien(id, { statusKsef: 'robocza', blad: undefined }),
      usunSzkic: (id) => setFaktury((lista) => lista.filter((f) => !(f.id === id && f.statusKsef === 'robocza'))),
      cykliczne,
      zapiszCykliczna: (c) =>
        setCykliczne((lista) => (lista.some((x) => x.id === c.id) ? lista.map((x) => (x.id === c.id ? c : x)) : [...lista, c])),
      usunCykliczna: (id) => setCykliczne((lista) => lista.filter((x) => x.id !== id)),
      koszty,
      zapiszKoszt: (k) => {
        const id = k.id || `w${Date.now()}`;
        setKoszty((lista) => (lista.some((x) => x.id === id) ? lista.map((x) => (x.id === id ? { ...k, id } : x)) : [{ ...k, id }, ...lista]));
        return id;
      },
      usunKoszt: (id) => setKoszty((lista) => lista.filter((x) => x.id !== id)),
      wgrajDokument: async () => {
        await poczekaj(CZAS_WGRANIA_MS);
        licznik.current += 1;
        const odczytId = `odczyt-${licznik.current}`;
        odczyty.current.set(odczytId, { od: Date.now() });
        return { ok: true, odczytId };
      },
      stanOdczytu: async (odczytId) => {
        const o = odczyty.current.get(odczytId);
        if (!o) return { stan: 'brak' };
        if (o.wydatekId) return { stan: 'gotowy', wydatekId: o.wydatekId };
        if (Date.now() - o.od < CZAS_ODCZYTU_MS) return { stan: 'trwa' };
        // Jak worker na serwerze: odczyt zapisuje wydatek „do opisania”.
        const wydatekId = `w${Date.now()}`;
        o.wydatekId = wydatekId;
        setKoszty((lista) => [{ ...ROZPOZNANY, id: wydatekId }, ...lista]);
        return { stan: 'gotowy', wydatekId };
      },
      odswiezWydatki: () => Promise.resolve(),
      zatwierdzKoszt: async (k, f) => {
        setKoszty((lista) =>
          lista.map((x) =>
            x.id === k.id
              ? {
                  ...x,
                  dostawca: f.dostawca.trim(),
                  nip: f.nip.trim() || undefined,
                  numer: f.numer.trim(),
                  data: f.data,
                  netto: f.netto,
                  vat: f.vat,
                  brutto: f.brutto,
                  kolumna: f.kolumna,
                  kategoria: f.kategoria,
                  wKpir: f.wKpir,
                  opis: f.notatki.trim(),
                  doOpisania: false,
                }
              : x,
          ),
        );
        return { ok: true, id: k.id };
      },
      flagi,
      ustawFlage: (klucz, v) => setFlagi((f) => ({ ...f, [klucz]: v })),
      wyczysc: () => {
        for (const zegar of zegary.current) clearTimeout(zegar);
        zegary.current.clear();
        setFaktury(FAKTURY);
        setCykliczne(CYKLICZNE);
        setKoszty(KOSZTY);
        odczyty.current.clear();
        setFlagi({});
        setPotwierdzenie(undefined);
        setCofnij(undefined);
      },
    };
  }, [faktury, cykliczne, koszty, flagi, potwierdzenie, cofnij]);

  return <Kontekst value={wartosc}>{children}</Kontekst>;
}

/**
 * Podmienia część stanu dla ekranów pod spodem (dane z bazy na prawdziwym
 * koncie, `stan/dane.tsx`). Reszta, np. przełączniki ustawień, zostaje z
 * dostawcy wyżej.
 */
export function PodmienStan({ zmiana, children }: { zmiana: (stan: Stan) => Stan; children: ReactNode }) {
  const wyzej = use(Kontekst);
  if (!wyzej) throw new Error('PodmienStan poza <StanFaktur>');
  return <Kontekst value={zmiana(wyzej)}>{children}</Kontekst>;
}

/** Systemowy arkusz udostępniania z opisem faktury (PDF dochodzi w M10). */
export function udostepnijFakture(f: Faktura): void {
  void Share.share({ message: `Faktura ${f.numer} dla ${f.kontrahent}, ${kwota(f.brutto, f.waluta)}.` });
}

export function useStanFaktur(): Stan {
  const stan = use(Kontekst);
  if (!stan) throw new Error('useStanFaktur poza <StanFaktur>');
  return stan;
}

/** Wartość przełącznika z domyślną wartością (ustawienia na danych przykładowych). */
export function useFlaga(klucz: string, domyslnie: boolean): [boolean, (v: boolean) => void] {
  const { flagi, ustawFlage } = useStanFaktur();
  return [flagi[klucz] ?? domyslnie, (v) => ustawFlage(klucz, v)];
}
