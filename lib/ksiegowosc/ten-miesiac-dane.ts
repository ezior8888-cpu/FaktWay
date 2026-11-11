/**
 * Odczyt „Ten miesiąc” (plan księgowości JDG, K4): parametry sprawdzone przez
 * księgową (D7), ewidencja roku (K3), zatwierdzone rozliczenia i zapłaty
 * (`tax_settlements`, 00168), potem `tenMiesiac`. Wynik po bramce D7 przechodzi
 * przez strażnika (żelazny filtr F13, `lib/bezpieczniki/ten-miesiac.ts`):
 * pozycja z błędem spójności staje się brakiem, a operator dostaje alarm.
 * Każde policzone rozliczenie dostaje skrót kwoty i jej bezpośrednich wejść:
 * zatwierdzenie zapisuje go, a inny skrót po zmianie danych oznacza nową
 * wersję (D6).
 */

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { zglosAlarmy } from '@/lib/bezpieczniki/alarm';
import { sprawdzTenMiesiac } from '@/lib/bezpieczniki/ten-miesiac';
import { monthRange } from '@/lib/expenses/month';
import { czytajEwidencje } from '@/lib/ksiegowosc/ewidencja-dane';
import { czytajKpir } from '@/lib/ksiegowosc/kpir-dane';
import { czytajWersjeProfilu, type WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { BLAD_ODCZYTU_VAT, brakNadwyzki, czytajVat, type DaneVat } from '@/lib/ksiegowosc/vat-dane';
import { statusObszaru } from '@/lib/ksiegowosc/wylacznik';
import { brakujace, parametryRoku, rokSkladkowyZdrowotnej, type Liczba, type NazwaSekcji } from '@/lib/ksiegowosc/parametry';
import {
  tenMiesiac,
  wersjaMiesiaca,
  type BrakPozycji,
  type Platnosc,
  type PozycjaDoZaplaty,
  type PozycjaMiesiaca,
  type VatWejscie,
  type RodzajRozliczenia,
  type WynikMiesiaca,
} from '@/lib/ksiegowosc/ten-miesiac';

export interface Rozliczenie {
  id: string;
  /** RRRR-MM */
  miesiac: string;
  rodzaj: RodzajRozliczenia;
  wersja: number;
  kwotaGr: number;
  termin: string;
  status: 'zatwierdzone' | 'zaplacone';
  wejsciaHash: string;
  zatwierdzoneO: string;
  zaplaconeO: string | null;
  spoleczneBezFpGr: number;
  /** Zapłata spoza wyliczenia (K7.2, `migawka.reczna`): kwota z PUE ZUS, nie z modułu. */
  reczna: boolean;
}

export type PozycjaPoliczona = { ok: true; wejsciaHash: string } & PozycjaDoZaplaty;
export type PozycjaZeSkrotem = PozycjaPoliczona | ({ ok: false } & BrakPozycji);

export type DaneMiesiaca =
  | {
      ok: true;
      wynik: WynikMiesiaca;
      pozycje: PozycjaZeSkrotem[];
      /** Skrót wartości parametrów (bez opisów), do audytu i kolumny `parametry_wersja`. */
      parametryWersja: string;
      /** Wszystkie wersje rozliczeń tego miesiąca, rosnąco. */
      rozliczenia: Rozliczenie[];
      /** Zapłaty spoza wyliczenia (K7.2): zapłacone w tym miesiącu i jeszcze bez daty zapłaty. */
      zaplatyReczne: Rozliczenie[];
    }
  | { ok: false; braki: string[]; rozliczenia: Rozliczenie[]; zaplatyReczne: Rozliczenie[] };

export const KOLUMNY_ROZLICZENIA =
  'id, okres, rodzaj, wersja, kwota_gr, termin, status, wejscia_hash, zatwierdzone_o, zaplacone_o, spoleczne_bez_fp:migawka->spoleczneBezFpGr, reczna:migawka->reczna';

interface WierszRozliczenia {
  id: string;
  okres: string;
  rodzaj: RodzajRozliczenia;
  wersja: number;
  kwota_gr: number | string;
  termin: string;
  status: 'zatwierdzone' | 'zaplacone';
  wejscia_hash: string;
  zatwierdzone_o: string;
  zaplacone_o: string | null;
  spoleczne_bez_fp: number | string | null;
  reczna?: boolean | null;
}

export function zWierszaRozliczenia(w: WierszRozliczenia): Rozliczenie {
  return {
    id: w.id,
    miesiac: w.okres.slice(0, 7),
    rodzaj: w.rodzaj,
    wersja: w.wersja,
    kwotaGr: Number(w.kwota_gr),
    termin: w.termin,
    status: w.status,
    wejsciaHash: w.wejscia_hash,
    zatwierdzoneO: w.zatwierdzone_o,
    zaplaconeO: w.zaplacone_o,
    spoleczneBezFpGr: Number(w.spoleczne_bez_fp ?? 0),
    reczna: w.reczna === true,
  };
}

/** JSON z kluczami po kolei: ten sam obiekt zawsze daje ten sam skrót. */
export function stabilnyJson(wartosc: unknown): string {
  if (Array.isArray(wartosc)) return `[${wartosc.map(stabilnyJson).join(',')}]`;
  if (wartosc && typeof wartosc === 'object') {
    const wpisy = Object.entries(wartosc as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${wpisy.map(([k, v]) => `${JSON.stringify(k)}:${stabilnyJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(wartosc ?? null);
}

export const skrot = (tekst: string) => createHash('sha256').update(tekst).digest('hex');

/**
 * Skrót rozliczenia (D6): kwota i jej bezpośrednie wejścia. Parametry roku nie
 * wchodzą wprost: zmiana liczby, która zmienia kwotę, zmienia skrót przez
 * kwotę, a poprawka opisu albo liczby, której pozycja nie używa, nie tworzy
 * nowej wersji.
 */
export function skrotPozycji(miesiac: string, p: Pick<PozycjaDoZaplaty, 'rodzaj' | 'kwotaGr' | 'wejscia'>): string {
  return skrot(stabilnyJson({ miesiac, rodzaj: p.rodzaj, kwotaGr: p.kwotaGr, wejscia: p.wejscia }));
}

const wartosci = (sekcja?: { liczby: Readonly<Record<string, Liczba>> }) =>
  sekcja ? Object.fromEntries(Object.entries(sekcja.liczby).map(([klucz, l]) => [klucz, l.wartosc])) : null;

function czyBrakTabeli(kod: string | undefined): boolean {
  // Przed wgraniem 00168: Postgres 42P01, PostgREST PGRST205.
  return kod === '42P01' || kod === 'PGRST205';
}

/**
 * Wersje rozliczeń miesiąca i wszystkie zapłacone wersje do tego miesiąca:
 * odliczenia liczą się po dniu zapłaty, więc liczy się też zaległa zapłata
 * za wcześniejszy okres (np. składki za listopad zapłacone w styczniu).
 */
export async function czytajRozliczenia(client: SupabaseClient, tenantId: string, miesiac: string): Promise<Rozliczenie[]> {
  const okres = `${miesiac}-01`;
  const wiersze = await readCompletePages<WierszRozliczenia>('ten miesiąc: rozliczenia', async (from, to) => {
    const wynik = await client
      .from('tax_settlements')
      .select(KOLUMNY_ROZLICZENIA, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .lte('okres', okres)
      // Ten miesiąc, zapłacone (odliczenia) i zapłaty spoza wyliczenia jeszcze bez daty (K7.2: lista z wyjściem).
      .or(`okres.eq.${okres},status.eq.zaplacone,migawka->>reczna.eq.true`)
      .order('id', { ascending: true })
      .range(from, to);
    if (wynik.error && czyBrakTabeli(wynik.error.code)) return { data: [], count: 0, error: null };
    return { data: wynik.data as WierszRozliczenia[] | null, count: wynik.count, error: wynik.error };
  });
  return wiersze.map(zWierszaRozliczenia).sort((a, b) => a.miesiac.localeCompare(b.miesiac) || a.rodzaj.localeCompare(b.rodzaj) || a.wersja - b.wersja);
}

/** Rozliczeń nie udało się odczytać: wołający nie może uznać, że nic nie jest zapłacone. */
export const KPIR_WYLACZONA =
  'Rozliczenie skali podatkowej i podatku liniowego jest w FaktWay chwilowo wyłączone, więc kwot za ten miesiąc nie liczymy. ' +
  'Faktury i koszty są w raporcie w zakładce „KPiR”.';

export const BLAD_ODCZYTU_ROZLICZEN = 'Nie udało się odczytać rozliczeń, więc nie pokazujemy kwot. Strona spróbuje ponownie przy następnym otwarciu.';

export interface OpcjeMiesiaca {
  /** P_39 wpisane przez klienta na ekranie (`?nadwyzka=`, pełne złote); bez niego null. */
  nadwyzkaVat?: number | null;
}

export async function czytajTenMiesiac(client: SupabaseClient, tenantId: string, miesiac: string, opcje: OpcjeMiesiaca = {}): Promise<DaneMiesiaca> {
  const rok = Number(miesiac.slice(0, 4));
  const rokSkladkowy = rokSkladkowyZdrowotnej(miesiac);

  // VAT (K7.1) za obszarem `vat`; wołający sprawdził już globalny stop i flagę firmy.
  const odczytVat: Promise<DaneVat | null> = statusObszaru('vat').wlaczony
    ? czytajVat(client, tenantId, miesiac, opcje.nadwyzkaVat ?? null).catch(() => ({ ok: false as const, komunikat: BLAD_ODCZYTU_VAT }))
    : Promise.resolve(null);
  const [odczyt, wersjeOdczyt, daneVat] = await Promise.all([
    czytajRozliczenia(client, tenantId, miesiac).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    czytajWersjeProfilu(client, tenantId).then(
      (w) => ({ ok: true as const, w }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    odczytVat,
  ]);
  const vat = vatMiesiaca(daneVat);
  if (!odczyt.ok) {
    console.error('[ten-miesiac] rozliczenia', odczyt.e instanceof Error ? odczyt.e.message : odczyt.e);
    return { ok: false, braki: [BLAD_ODCZYTU_ROZLICZEN], rozliczenia: [], zaplatyReczne: [] };
  }
  const tegoMiesiaca = odczyt.r.filter((r) => r.miesiac === miesiac);
  const zaplatyReczne = odczyt.r.filter((r) => r.reczna && (r.status === 'zatwierdzone' || r.zaplaconeO?.slice(0, 7) === miesiac));
  if (!wersjeOdczyt.ok) {
    console.error('[ten-miesiac] profil', wersjeOdczyt.e instanceof Error ? wersjeOdczyt.e.message : wersjeOdczyt.e);
    return { ok: false, braki: [BLAD_ODCZYTU_ROZLICZEN], rozliczenia: tegoMiesiaca, zaplatyReczne };
  }
  const forma = wersjaMiesiaca(wersjeOdczyt.w, miesiac)?.forma ?? 'ryczalt';
  // Skala i liniowy (K7) za obszarem `kpir`; wołający sprawdził już globalny stop i flagę firmy.
  if (forma !== 'ryczalt' && !statusObszaru('kpir').wlaczony) return { ok: false, braki: [KPIR_WYLACZONA], rozliczenia: tegoMiesiaca, zaplatyReczne };

  // D7: bez sekcji potwierdzonej przez księgową nie ma kwoty tej pozycji. Liczbę
  // bez wartości (np. stopa wypadkowa ogłaszana w kwietniu) sprawdza silnik,
  // który jej używa, więc nie zabiera ona miesięcy, które jej nie potrzebują.
  // Podatek to ryczałt albo zaliczka PIT (skala, liniowy) według formy.
  const sekcje: [RodzajRozliczenia, number, NazwaSekcji][] = [
    forma === 'ryczalt' ? ['ryczalt', rok, 'ryczalt'] : ['pit', rok, forma],
    ['zus_spoleczne', rok, 'zus'],
    ['zdrowotna', rokSkladkowy, 'zdrowotna'],
  ];
  const d7 = new Map<RodzajRozliczenia, string>();
  for (const [rodzaj, r, sekcja] of sekcje) {
    const brak = brakujace(r, [sekcja]).find((b) => b.powod !== 'brak_liczby');
    if (brak) d7.set(rodzaj, brak.komunikat);
  }
  // VAT nie zależy od parametrów modułu: z kwotą albo z polem na nieznaną nadwyżkę miesiąc liczy się dalej
  // (pozostałe pozycje z brakami D7). Sam błąd odczytu VAT niczego tu nie dodaje.
  const vatNaEkranie = vat !== null && (vat.ok || vat.nadwyzkaNieznana);
  if (d7.size === sekcje.length && !vatNaEkranie) return { ok: false, braki: [...new Set(d7.values())], rozliczenia: tegoMiesiaca, zaplatyReczne };

  const ksiegi = await czytajKsiegi(client, tenantId, miesiac, forma, wersjeOdczyt.w);
  if (!ksiegi.ok) return { ok: false, braki: [ksiegi.komunikat], rozliczenia: tegoMiesiaca, zaplatyReczne };

  const platnosci: Platnosc[] = odczyt.r
    .filter((r) => r.status === 'zaplacone' && r.zaplaconeO)
    .map((r) => ({
      miesiac: r.miesiac,
      rodzaj: r.rodzaj,
      wersja: r.wersja,
      kwotaGr: r.kwotaGr,
      spoleczneBezFpGr: r.spoleczneBezFpGr,
      zaplaconeO: r.zaplaconeO as string,
    }));

  const wynik = tenMiesiac({ miesiac, ...ksiegi.wejscie, vat, wersje: wersjeOdczyt.w, platnosci, parametry: parametryRoku });
  if (!wynik.ok) return { ok: false, braki: wynik.braki, rozliczenia: tegoMiesiaca, zaplatyReczne };

  const maskowane: PozycjaMiesiaca[] = wynik.wynik.pozycje.map((poz) => {
    const brak = d7.get(poz.rodzaj);
    return brak ? { ok: false, rodzaj: poz.rodzaj, termin: poz.termin, brak } : poz;
  });
  const bezD7 = bezKwot(wynik.wynik, new Set(d7.keys()), maskowane);
  // Strażnik (żelazny filtr F13, D-F7): ostatnia kontrola przed stroną, zatwierdzeniem,
  // cronami i „Odłóż na podatek”. Pozycja z błędem spójności to brak z komunikatem, a operator dostaje alarm.
  const kontrola = sprawdzTenMiesiac(bezD7);
  zglosAlarmy(kontrola.alarmy, { tenantId, straznik: 'ten-miesiac' });
  const sprawdzony = bezKwot(bezD7, new Set(kontrola.alarmy.map((a) => a.rodzaj)), kontrola.pozycje);
  const pozycje: PozycjaZeSkrotem[] = kontrola.pozycje.map((poz) => (poz.ok ? { ...poz, wejsciaHash: skrotPozycji(miesiac, poz) } : poz));

  const p = parametryRoku(rok);
  const pz = parametryRoku(rokSkladkowy);
  const podatek = forma === 'ryczalt' ? { ryczalt: wartosci(p?.ryczalt) } : { [forma]: wartosci(p?.[forma]) };
  const parametryWersja = skrot(stabilnyJson({ ...podatek, zus: wartosci(p?.zus), zdrowotna: wartosci(pz?.zdrowotna) })).slice(0, 16);

  return { ok: true, wynik: sprawdzony, pozycje, parametryWersja, rozliczenia: tegoMiesiaca, zaplatyReczne };
}

/**
 * Wynik bez kwot pozycji z `bez`: sekcja bez podpisu księgowej (D7) albo
 * pozycja zatrzymana przez strażnika (F13). Ich kwoty nie idą dalej, także do
 * opisu odliczeń pod kaflami. VAT jak brak z innego powodu niż nadwyżka: bez
 * kwot deklaracji i bez pola nadwyżki, bo wpisana nadwyżka niczego tu nie zmieni.
 */
function bezKwot(w: WynikMiesiaca, bez: ReadonlySet<RodzajRozliczenia>, pozycje: PozycjaMiesiaca[]): WynikMiesiaca {
  return {
    ...w,
    ryczalt: bez.has('ryczalt') ? null : w.ryczalt,
    pit: bez.has('pit') ? null : w.pit,
    skladki: bez.has('zus_spoleczne') ? null : w.skladki,
    zdrowotna: bez.has('zdrowotna') ? null : w.zdrowotna,
    zdrowotnaOdDochodu: bez.has('zdrowotna') ? null : w.zdrowotnaOdDochodu,
    vat: w.vat && bez.has('vat') ? { wynik: null, nadwyzka: null, nadwyzkaNieznana: false } : w.vat,
    pozycje,
  };
}

/**
 * VAT miesiąca dla silnika (K7.1): firma zwolniona albo obszar zablokowany to
 * brak pozycji; nieznana nadwyżka to brak z wyjściem (pole na ekranie, a po
 * zatwierdzeniu kolejny miesiąc bierze P_62 z tego rozliczenia).
 */
function vatMiesiaca(d: DaneVat | null): VatWejscie | null {
  if (!d) return null;
  if (!d.ok) return d.zwolniona ? null : { ok: false, brak: d.komunikat, nadwyzkaNieznana: false };
  if (!d.nadwyzka || !d.wynik) {
    return {
      ok: false,
      brak: `${brakNadwyzki(d.miesiac)} Kwotę wpisuje się przy tej pozycji; po zatwierdzeniu miesiąca kolejny bierze nadwyżkę z tego rozliczenia.`,
      nadwyzkaNieznana: true,
    };
  }
  if (!d.wynik.ok) return { ok: false, brak: d.wynik.brak, nadwyzkaNieznana: false };
  const { ok: _ok, ...wynik } = d.wynik;
  return { ok: true, wynik, nadwyzka: d.nadwyzka };
}

/**
 * Księga miesiąca według formy: ewidencja przychodów przy ryczałcie (K3), KPiR
 * przy skali i liniowym (K7); za styczeń także KPiR roku poprzedniego, bo
 * składka zdrowotna liczy się od dochodu z grudnia. Wersje profilu są już
 * przeczytane, więc odczyty ksiąg ich nie powtarzają.
 */
async function czytajKsiegi(
  client: SupabaseClient,
  tenantId: string,
  miesiac: string,
  forma: WersjaProfilu['forma'],
  wersje: readonly WersjaProfilu[],
): Promise<{ ok: true; wejscie: Pick<Parameters<typeof tenMiesiac>[0], 'ewidencja' | 'kpir'> } | { ok: false; komunikat: string }> {
  const rok = Number(miesiac.slice(0, 4));
  if (forma === 'ryczalt') {
    const e = await czytajEwidencje(client, tenantId, rok, { wersje });
    return e.ok ? { ok: true, wejscie: { ewidencja: e.ewidencja } } : e;
  }
  const [biezacy, poprzedni] = await Promise.all([
    czytajKpir(client, tenantId, rok, { wersje }),
    miesiac.endsWith('-01') ? czytajKpir(client, tenantId, rok - 1, { wersje }) : null,
  ]);
  if (!biezacy.ok) return biezacy;
  return {
    ok: true,
    wejscie: {
      kpir: {
        rok: biezacy.kpir,
        poprzedni: poprzedni?.ok ? poprzedni.kpir : null,
        ...(poprzedni && !poprzedni.ok ? { brakPoprzedniego: poprzedni.komunikat } : {}),
      },
    },
  };
}

/** Najnowsza wersja każdego rodzaju (aktualne rozliczenie). */
export function aktualne(rozliczenia: readonly Rozliczenie[]): Map<RodzajRozliczenia, Rozliczenie> {
  const mapa = new Map<RodzajRozliczenia, Rozliczenie>();
  for (const r of rozliczenia) {
    const obecne = mapa.get(r.rodzaj);
    if (!obecne || r.wersja > obecne.wersja) mapa.set(r.rodzaj, r);
  }
  return mapa;
}

export const PO_KONCU_MIESIACA = 'Miesiąc zatwierdza się po jego zakończeniu, gdy są już wszystkie przychody.';

/** Czy miesiąc już się skończył (zatwierdza się dopiero wtedy). */
export const miesiacZakonczony = (miesiac: string, dzis: string) => monthRange(miesiac).to < dzis;

/** Rozliczenia do zatwierdzenia: policzone pozycje ze skrótem innym niż ostatnia wersja. */
export function doZatwierdzenia(dane: Extract<DaneMiesiaca, { ok: true }>): PozycjaPoliczona[] {
  const ostatnie = aktualne(dane.rozliczenia);
  return dane.pozycje.filter((p): p is PozycjaPoliczona => p.ok && ostatnie.get(p.rodzaj)?.wejsciaHash !== p.wejsciaHash);
}

/**
 * Ile z rozliczenia jest już zapłacone: najwyższa zapłacona wersja, tak jak
 * liczy dopłaty `przyrostyZaplat`; do dopłaty zostaje kwota ponad nią.
 */
export function zaplacono(rozliczenia: readonly Rozliczenie[], rodzaj: RodzajRozliczenia): number {
  return rozliczenia.filter((r) => r.rodzaj === rodzaj && r.status === 'zaplacone').reduce((m, r) => Math.max(m, r.kwotaGr), 0);
}
