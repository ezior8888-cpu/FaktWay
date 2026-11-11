/**
 * Atrapa PostgREST dla testów nocnej kopii JSON (plan skalowania, sesja 12).
 *
 * Tabela to tablica wierszy w „kolejności fizycznej”, czyli tak, jak Postgres
 * oddaje je bez ORDER BY. Zapytanie bez `order` widzi tę kolejność (OFFSET
 * przez `range`), zapytanie z `order` sortuje. Hak `poOdczycie` pozwala zmienić
 * tabelę między stronami: nowy wiersz w wolnym miejscu na początku tabeli,
 * nowa wersja zmienionego wiersza na końcu (tak zapisuje ją UPDATE).
 *
 * Obsługuje to, czego używa kopia: `select`, `range`, `order`, `gt`, `gte`,
 * `eq`, `or` (z wartościami w cudzysłowie, jak w PostgREST), `limit`, liczenie
 * `count`/`head` i RPC `list_public_tables`. Odpowiedź ucina do `maxRows`
 * (produkcyjne PGRST_DB_MAX_ROWS = 1000).
 */

export type Wiersz = Record<string, unknown>;

export interface Odczyt {
  tabela: string;
  /** Liczba zwróconych wierszy. */
  wiersze: number;
  /** Czy zapytanie sortowało (`order`). */
  posortowane: boolean;
}

export interface AtrapaOpcje {
  tabele: Record<string, Wiersz[]>;
  maxRows?: number;
  /** Woła się po każdym odczycie tabeli (licznik od 1 per tabela). */
  poOdczycie?: (tabela: string, numerOdczytu: number, tabele: Record<string, Wiersz[]>) => void;
}

type Warunek = (w: Wiersz) => boolean;

function porownaj(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function wartoscFiltra(wartosc: unknown, wzor: unknown): unknown {
  return typeof wzor === 'number' ? Number(wartosc) : wartosc;
}

function operator(kolumna: string, op: string, wartosc: string): Warunek {
  return (w) => {
    const v = w[kolumna];
    const c = porownaj(v, wartoscFiltra(wartosc, v));
    switch (op) {
      case 'gt':
        return c > 0;
      case 'gte':
        return c >= 0;
      case 'eq':
        return c === 0;
      case 'lt':
        return c < 0;
      default:
        throw new Error(`atrapa: nieobsługiwany operator ${op}`);
    }
  };
}

/**
 * Parser drzewa `or=(...)` PostgREST: `kol.op.wartosc`, `and(...)`, `or(...)`,
 * wartość w cudzysłowie z `\"` i `\\` (jak `pQuotedValue` w PostgREST).
 */
function parsujLogike(tekst: string): Warunek {
  let i = 0;

  function lista(): Warunek[] {
    const wyniki: Warunek[] = [element()];
    while (tekst[i] === ',') {
      i += 1;
      wyniki.push(element());
    }
    return wyniki;
  }

  function element(): Warunek {
    for (const slowo of ['and(', 'or(']) {
      if (tekst.startsWith(slowo, i)) {
        i += slowo.length;
        const dzieci = lista();
        if (tekst[i] !== ')') throw new Error(`atrapa: brak ')' na pozycji ${i}`);
        i += 1;
        return slowo === 'and('
          ? (w) => dzieci.every((d) => d(w))
          : (w) => dzieci.some((d) => d(w));
      }
    }
    const kropka1 = tekst.indexOf('.', i);
    const kolumna = tekst.slice(i, kropka1);
    const kropka2 = tekst.indexOf('.', kropka1 + 1);
    const op = tekst.slice(kropka1 + 1, kropka2);
    i = kropka2 + 1;
    let wartosc = '';
    if (tekst[i] === '"') {
      i += 1;
      while (tekst[i] !== '"') {
        if (i >= tekst.length) throw new Error('atrapa: niezamknięty cudzysłów');
        if (tekst[i] === '\\') i += 1;
        wartosc += tekst[i];
        i += 1;
      }
      i += 1;
    } else {
      while (i < tekst.length && tekst[i] !== ',' && tekst[i] !== ')') {
        if (tekst[i] === '"' || tekst[i] === '(') {
          throw new Error(`atrapa: znak zastrzeżony bez cudzysłowu w ${tekst}`);
        }
        wartosc += tekst[i];
        i += 1;
      }
    }
    if (!kolumna || !op) throw new Error(`atrapa: nieczytelny warunek w ${tekst}`);
    return operator(kolumna, op, wartosc);
  }

  const wynik = lista();
  if (i !== tekst.length) throw new Error(`atrapa: nadmiarowy tekst w ${tekst}`);
  return (w) => wynik.some((d) => d(w));
}

export function utworzAtrape(opcje: AtrapaOpcje) {
  const maxRows = opcje.maxRows ?? 1000;
  const tabele = opcje.tabele;
  const odczyty: Odczyt[] = [];
  const licznikOdczytow = new Map<string, number>();

  function zapytanie(tabela: string) {
    const warunki: Warunek[] = [];
    const kolumnyWarunkow: string[] = [];
    const sortowanie: Array<{ kolumna: string; rosnaco: boolean }> = [];
    let zakres: [number, number] | null = null;
    let limit: number | null = null;
    let liczenie = false;
    let wybrane: string[] = [];

    function wykonaj(): { data: Wiersz[] | null; error: { message: string; code?: string } | null; count?: number | null } {
      const zrodlo = tabele[tabela];
      if (!zrodlo) return { data: null, error: { message: `relation "public.${tabela}" does not exist`, code: '42P01' } };
      const znane = new Set(zrodlo.flatMap((w) => Object.keys(w)));
      for (const k of [...wybrane, ...kolumnyWarunkow, ...sortowanie.map((s) => s.kolumna)]) {
        if (zrodlo.length > 0 && !znane.has(k)) {
          return { data: null, error: { message: `column ${tabela}.${k} does not exist`, code: '42703' } };
        }
      }
      let wynik = zrodlo.filter((w) => warunki.every((d) => d(w)));
      if (liczenie) return { data: null, error: null, count: wynik.length };
      if (sortowanie.length > 0) {
        wynik = [...wynik].sort((a, b) => {
          for (const s of sortowanie) {
            const c = porownaj(a[s.kolumna], b[s.kolumna]);
            if (c !== 0) return s.rosnaco ? c : -c;
          }
          return 0;
        });
      }
      if (zakres) wynik = wynik.slice(zakres[0], zakres[1] + 1);
      if (limit !== null) wynik = wynik.slice(0, limit);
      wynik = wynik.slice(0, maxRows).map((w) => ({ ...w }));

      const n = (licznikOdczytow.get(tabela) ?? 0) + 1;
      licznikOdczytow.set(tabela, n);
      odczyty.push({ tabela, wiersze: wynik.length, posortowane: sortowanie.length > 0 });
      opcje.poOdczycie?.(tabela, n, tabele);
      return { data: wynik, error: null };
    }

    const q = {
      select(kolumny: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) liczenie = true;
        wybrane = kolumny === '*' ? [] : kolumny.split(',').map((k) => k.trim());
        return q;
      },
      order(kolumna: string, o?: { ascending?: boolean }) {
        sortowanie.push({ kolumna, rosnaco: o?.ascending !== false });
        return q;
      },
      gt(kolumna: string, wartosc: unknown) {
        kolumnyWarunkow.push(kolumna);
        warunki.push(operator(kolumna, 'gt', String(wartosc)));
        return q;
      },
      gte(kolumna: string, wartosc: unknown) {
        kolumnyWarunkow.push(kolumna);
        warunki.push(operator(kolumna, 'gte', String(wartosc)));
        return q;
      },
      eq(kolumna: string, wartosc: unknown) {
        kolumnyWarunkow.push(kolumna);
        warunki.push(operator(kolumna, 'eq', String(wartosc)));
        return q;
      },
      or(filtr: string) {
        warunki.push(parsujLogike(filtr));
        return q;
      },
      limit(n: number) {
        limit = n;
        return q;
      },
      range(od: number, doIndeksu: number) {
        zakres = [od, doIndeksu];
        return q;
      },
      then<T1, T2>(
        ok?: ((v: ReturnType<typeof wykonaj>) => T1 | PromiseLike<T1>) | null,
        blad?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
      ) {
        return Promise.resolve().then(wykonaj).then(ok, blad);
      },
    };
    return q;
  }

  const admin = {
    from: (tabela: string) => zapytanie(tabela),
    rpc: async (fn: string) =>
      fn === 'list_public_tables'
        ? { data: Object.keys(tabele).sort().map((t) => ({ table_name: t })), error: null }
        : { data: null, error: { message: `atrapa: nieznane RPC ${fn}` } },
  };

  return { admin, odczyty, tabele };
}

/** Uuid rosnący z numerem (sortuje się tekstowo jak w Postgresie). */
export function uuidNr(n: number, prefiks = '00000000'): string {
  return `${prefiks}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}
