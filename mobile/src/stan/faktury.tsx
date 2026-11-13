/**
 * Stan aplikacji na danych przykładowych: faktury (zapłata, nowe, wysyłka do
 * KSeF, usunięcie szkicu), faktury cykliczne i proste przełączniki ustawień.
 * Wspólny dla wszystkich ekranów. Prawdziwe dane i zapis przez API: M7 i M10
 * (np. `markInvoicePaidAction` po stronie strony).
 */
import * as Haptics from 'expo-haptics';
import { createContext, use, useMemo, useRef, useState, type ReactNode } from 'react';
import { Share } from 'react-native';

import { FAKTURY, KOSZTY, type Faktura, type Koszt } from '@/dane-przykladowe';
import { CYKLICZNE, type FakturaCykliczna } from '@/dane-przykladowe/kontrahenci';
import { kwota } from '@/lib/format';

type Stan = {
  faktury: Faktura[];
  /** Oznacza albo cofa zapłatę (z wibracją i paskiem „Cofnij”); jedno miejsce dla gestu, menu i przycisku. */
  przelaczZaplate: (f: Faktura) => void;
  /** Dodaje fakturę; `wyslij` symuluje wysyłkę do KSeF i przyjęcie po chwili. Zwraca id. */
  dodajFakture: (f: Faktura, wyslij: boolean) => string;
  /** Zapisuje poprawiony szkic albo odrzuconą fakturę w miejscu starej; `wyslij` jak w `dodajFakture`. */
  zastapFakture: (id: string, f: Faktura, wyslij: boolean) => void;
  /** Faktura właśnie wysłana z formularza: jej szczegół pokazuje kartę „Wysyłamy do KSeF” → „Przyjęta w KSeF”. */
  potwierdzenie: string | undefined;
  /** Pasek „Cofnij” nad zakładkami (`PasekCofnij`): co się stało i jak to odwrócić. */
  cofnij: { id: number; tekst: string; akcja: () => void } | undefined;
  pokazCofnij: (c: { tekst: string; akcja: () => void } | undefined) => void;
  pokazPotwierdzenie: (id: string | undefined) => void;
  /** Wysyła szkic albo odrzuconą fakturę ponownie do KSeF. */
  wyslijDoKsef: (id: string) => void;
  /** Cofa odrzuconą fakturę do szkicu. */
  wrocDoSzkicu: (id: string) => void;
  usunSzkic: (id: string) => void;
  cykliczne: FakturaCykliczna[];
  zapiszCykliczna: (c: FakturaCykliczna) => void;
  usunCykliczna: (id: string) => void;
  koszty: Koszt[];
  /** Zapisuje albo dodaje wydatek (opisanie, akceptacja, nowy ze zdjęcia). Zwraca id. */
  zapiszKoszt: (k: Koszt) => string;
  usunKoszt: (id: string) => void;
  /** Proste przełączniki ekranów ustawień i list (np. wstrzymane przypomnienia). */
  flagi: Record<string, boolean>;
  ustawFlage: (klucz: string, wartosc: boolean) => void;
};

const Kontekst = createContext<Stan | null>(null);

/** Czas „przyjęcia w KSeF” na danych przykładowych. */
const CZAS_KSEF_MS = 2500;

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

  const wartosc = useMemo<Stan>(() => {
    const zmien = (id: string, zmiana: Partial<Faktura>) =>
      setFaktury((lista) => lista.map((f) => (f.id === id ? { ...f, ...zmiana } : f)));

    const przyjmijPoChwili = (id: string) => {
      setTimeout(() => {
        setFaktury((lista) =>
          lista.map((f) =>
            f.id === id && f.statusKsef === 'wysylanie' ? { ...f, statusKsef: 'przyjeta', numerKsef: numerKsef(f), blad: undefined } : f,
          ),
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }, CZAS_KSEF_MS);
    };

    return {
      faktury,
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
        return id;
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
      flagi,
      ustawFlage: (klucz, v) => setFlagi((f) => ({ ...f, [klucz]: v })),
    };
  }, [faktury, cykliczne, koszty, flagi, potwierdzenie, cofnij]);

  return <Kontekst value={wartosc}>{children}</Kontekst>;
}

/** Systemowy arkusz udostępniania z opisem faktury (PDF dochodzi w M10). */
export function udostepnijFakture(f: Faktura): void {
  void Share.share({ message: `Faktura ${f.numer} dla ${f.kontrahent}, ${kwota(f.brutto)}.` });
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
