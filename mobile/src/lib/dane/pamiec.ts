/**
 * Dane z poprzedniego otwarcia (ZASADY-DESIGNU.md, sekcja 5: „najpierw
 * pokazujemy to, co mamy”; etap M7): konto z `GET /konto`, faktury i
 * skrzynka KSeF jednej firmy. Bez React Native: magazyn przychodzi z
 * zewnątrz (`pamiec-plikow.ts`), testy w `tests/unit/mobile-dane-pamiec.test.ts`.
 *
 * Każdy zapis zna konto i firmę, więc dane jednego konta nigdy nie pokażą
 * się na drugim, nawet gdyby czyszczenie przy wylogowaniu nie doszło do końca.
 * Wylogowanie i koniec sesji czyszczą całość (`wyczysc`).
 *
 * Pobranie z serwera trwa, a klient może się w tym czasie wylogować. Dlatego
 * zapis podaje epokę z początku pobrania (`epoka()`): po `wyczysc` stara
 * epoka nic już nie zapisze, a zapisy i czyszczenie idą po kolei, więc
 * czyszczenie nie minie się z zapisem, który właśnie trwa.
 */

export type Magazyn = {
  czytaj: (nazwa: string) => Promise<string | null>;
  zapisz: (nazwa: string, tekst: string) => Promise<void>;
  usunWszystko: () => Promise<void>;
};

/** Zmiana kształtu zapisanych danych podnosi wersję: stare zapisy się wtedy nie wczytają. */
export const WERSJA_PAMIECI = 1;

export type RodzajDanych = 'konto' | 'faktury' | 'skrzynka' | 'wydatki';

export type Zapis<T> = { wersja: number; uzytkownik: string; firma: string | null; zapisano: string; dane: T };

const BEZPIECZNY = /^[A-Za-z0-9-]+$/;

/** Nazwa pliku; identyfikatory to UUID, inne znaki odrzucamy, żeby nazwa nie wyszła poza katalog. */
export function nazwaZapisu(rodzaj: RodzajDanych, uzytkownik: string, firma: string | null): string | undefined {
  if (!BEZPIECZNY.test(uzytkownik) || (firma !== null && !BEZPIECZNY.test(firma))) return undefined;
  return `${rodzaj}-${uzytkownik}-${firma ?? 'konto'}.json`;
}

export function utworzPamiec(magazyn: Magazyn, teraz: () => Date = () => new Date()) {
  let epoka = 0;
  let kolejka: Promise<unknown> = Promise.resolve();
  const poKolei = <T>(krok: () => Promise<T>): Promise<T> => {
    const wynik = kolejka.then(krok, krok);
    kolejka = wynik.catch(() => undefined);
    return wynik;
  };

  return {
    /** Epoka teraz; podaj ją w `zapisz`, gdy zapisujesz wynik pobrania zaczętego wcześniej. */
    epoka: () => epoka,

    async czytaj<T>(rodzaj: RodzajDanych, uzytkownik: string, firma: string | null): Promise<{ dane: T; zapisano: string } | undefined> {
      const nazwa = nazwaZapisu(rodzaj, uzytkownik, firma);
      if (!nazwa) return undefined;
      try {
        const tekst = await magazyn.czytaj(nazwa);
        if (!tekst) return undefined;
        const z = JSON.parse(tekst) as Partial<Zapis<T>>;
        if (z.wersja !== WERSJA_PAMIECI || z.uzytkownik !== uzytkownik || (z.firma ?? null) !== firma || z.dane === undefined || typeof z.zapisano !== 'string') {
          return undefined;
        }
        return { dane: z.dane, zapisano: z.zapisano };
      } catch {
        return undefined;
      }
    },

    zapisz<T>(rodzaj: RodzajDanych, uzytkownik: string, firma: string | null, dane: T, epokaPobrania: number): Promise<string | undefined> {
      const nazwa = nazwaZapisu(rodzaj, uzytkownik, firma);
      if (!nazwa || epokaPobrania !== epoka) return Promise.resolve(undefined);
      const zapisano = teraz().toISOString();
      const z: Zapis<T> = { wersja: WERSJA_PAMIECI, uzytkownik, firma, zapisano, dane };
      return poKolei(async () => {
        // Czyszczenie mogło wejść do kolejki przed tym zapisem.
        if (epokaPobrania !== epoka) return undefined;
        try {
          await magazyn.zapisz(nazwa, JSON.stringify(z));
          return zapisano;
        } catch {
          // Pełny dysk albo błąd zapisu: dane są na ekranie, zabraknie ich tylko przy starcie bez sieci.
          return undefined;
        }
      });
    },

    /** Wylogowanie: od tej chwili zapisy pobrań zaczętych wcześniej przepadają. */
    wyczysc(): Promise<void> {
      epoka += 1;
      return poKolei(() => magazyn.usunWszystko());
    },
  };
}

export type Pamiec = ReturnType<typeof utworzPamiec>;
