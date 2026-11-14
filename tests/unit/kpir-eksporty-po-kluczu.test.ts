import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import { czytajEwidencje, KOMUNIKAT_ODCZYT } from '@/lib/ksiegowosc/ewidencja-dane';
import { czytajKpir } from '@/lib/ksiegowosc/kpir-dane';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { getKpirData } from '@/lib/reports/kpir-data';
import type { PageContext } from '@/lib/supabase/page-context';

import { fakePostgrest, type Row, type Tables } from '../helpers/fake-postgrest';

/**
 * Sesja 33 planu skalowania (QRY-07, reszta z #352): KPiR i eksporty czytają
 * strony po kluczu (`readCompletePagesByKey`), a wyniki się nie zmieniają.
 *
 * Prawdziwe: cztery wejścia (raport KPiR `getKpirData`, dane eksportu
 * `fetchInvoicesForExport`, KPiR modułu `czytajKpir`, ewidencja przychodów
 * `czytajEwidencje`), wszystkie ich odczyty i strażniki oraz atrapa PostgREST
 * z `lib/demo/fake-postgrest.ts` (z limitem 1000 wierszy serwera). Zastąpiony
 * tylko klient admina (wejścia dostają klienta jawnie). Atrapa nie ma `lte`
 * ani `single`, więc dokłada je opakowanie niżej.
 *
 * Duża firma ma w KAŻDYM z 12 odczytów stronami ponad 500 wierszy (dwie albo
 * trzy strony), mała firma mieści każdy odczyt na jednej stronie.
 *
 * Złoty wzorzec: `tests/fixtures/kpir-eksporty-przed-sesja-33.json` to odcisk
 * SHA-256 pełnego wyniku każdego wejścia (i kilka liczb do podglądu) z kodu
 * SPRZED sesji 33 (`main` febb5d5c, strony z OFFSET i COUNT na każdej). Po
 * zmianie te same dane mają dać ten sam wynik, bajt po bajcie. Wzorzec
 * zapisuje się tylko na żądanie:
 * `KPIR_WZORZEC=zapisz pnpm vitest run tests/unit/kpir-eksporty-po-kluczu`.
 */

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    throw new Error('test podaje klienta jawnie');
  },
}));

const WZORZEC = join(process.cwd(), 'tests/fixtures/kpir-eksporty-przed-sesja-33.json');
const NOW = new Date('2026-11-14T09:00:00Z');
const STRONA = 500;
const FIRMA = 'f0000000-0000-4000-8000-000000000001';
const INNA_FIRMA = 'f0000000-0000-4000-8000-000000000002';

// ─── Atrapa licząca zapytania ─────────────────────────────────────────────

/** Jedno zapytanie: tabela, `select`, filtry oraz to, czym przewija strony. */
interface Zapytanie {
  tabela: string;
  kolumny: string;
  count: boolean;
  head: boolean;
  /** Filtry poza stronicowaniem, w kolejności wywołań. */
  filtry: Array<[string, unknown[]]>;
  sortowanie: unknown[][];
  /** `gt('id', …)`: strona po kluczu. */
  poKluczu: string | null;
  limit: number | null;
  range: [number, number] | null;
  /** Odpowiedź: liczba rekordów (przy `count`), wiersze i `id` ostatniego. */
  licznik: number | null;
  wiersze: number;
  ostatnieId: string | null;
}

interface Zaklocenia {
  /** Zmienia tabele tuż przed odpowiedzią na zapytanie (zapis w trakcie odczytu). */
  przed?: (z: Zapytanie, tabele: Tables) => void;
}

type Metoda = (...args: unknown[]) => unknown;

function liczacyKlient(tabele: Tables, log: Zapytanie[], zaklocenia: Zaklocenia = {}) {
  const baza = fakePostgrest(tabele) as unknown as { from(tabela: string): Record<string, Metoda> };
  return {
    from(tabela: string) {
      const z: Zapytanie = {
        tabela, kolumny: '*', count: false, head: false, filtry: [], sortowanie: [],
        poKluczu: null, limit: null, range: null, licznik: null, wiersze: 0, ostatnieId: null,
      };
      log.push(z);
      const wew = baza.from(tabela);
      const zapisz = (metoda: string, args: unknown[]) => {
        if (metoda === 'select') {
          const opcje = args[1] as { count?: string; head?: boolean } | undefined;
          z.kolumny = String(args[0] ?? '*');
          z.count = opcje?.count === 'exact';
          z.head = opcje?.head === true;
        } else if (metoda === 'order') {
          z.sortowanie.push(args);
        } else if (metoda === 'limit') {
          z.limit = Number(args[0]);
        } else if (metoda === 'range') {
          z.range = [Number(args[0]), Number(args[1])];
        } else if (metoda === 'gt' && args[0] === 'id') {
          z.poKluczu = String(args[1]);
        } else {
          z.filtry.push([metoda, args]);
        }
      };
      const b: Record<string, unknown> = {};
      for (const [metoda, f] of Object.entries(wew)) {
        if (metoda === 'then' || metoda === 'maybeSingle') continue;
        b[metoda] = (...args: unknown[]) => {
          zapisz(metoda, args);
          f(...args);
          return b;
        };
      }
      // `lte` jako jednowarunkowe `or(...)`: te same porównania tekstowe co `gte` w atrapie.
      b.lte = (kolumna: unknown, wartosc: unknown) => {
        zapisz('lte', [kolumna, wartosc]);
        wew.or(`${String(kolumna)}.lte.${String(wartosc)}`);
        return b;
      };
      b.maybeSingle = () => wew.maybeSingle();
      // Jak PostgREST: `single()` bez wiersza to błąd PGRST116.
      b.single = async () => {
        const wynik = (await wew.maybeSingle()) as { data: Row | null; error: unknown };
        if (wynik.data || wynik.error) return wynik;
        return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      };
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        zaklocenia.przed?.(z, tabele);
        return (wew.then as (r: (v: unknown) => unknown) => Promise<unknown>)((wynik) => {
          const w = wynik as { data: Row[] | null; count: number | null };
          z.licznik = w.count;
          z.wiersze = w.data?.length ?? 0;
          z.ostatnieId = w.data?.length ? String(w.data.at(-1)!.id) : null;
          return wynik;
        }).then(resolve, reject);
      };
      return b;
    },
  };
}

/** Strona odczytu stronami: sortowanie po `id` i okno strony (OFFSET przed sesją 33, `limit` po kluczu). */
const czyStronami = (z: Zapytanie) =>
  z.sortowanie.some(([kolumna]) => kolumna === 'id') && (z.range !== null || z.limit === STRONA);
const kluczOdczytu = (z: Zapytanie) => `${z.tabela}|${z.kolumny}|${JSON.stringify(z.filtry)}`;

/** Odczyty stronami: zapytania z tym samym `select` i filtrami, w kolejności. */
function odczytyStronami(log: readonly Zapytanie[]): Zapytanie[][] {
  const grupy = new Map<string, Zapytanie[]>();
  for (const z of log.filter(czyStronami)) grupy.set(kluczOdczytu(z), [...(grupy.get(kluczOdczytu(z)) ?? []), z]);
  return [...grupy.values()];
}

interface Ksztalt {
  count: boolean;
  head: boolean;
  poKluczu: string | null;
  limit: number | null;
  range: [number, number] | null;
}

const ksztalt = (z: Zapytanie): Ksztalt => ({ count: z.count, head: z.head, poKluczu: z.poKluczu, limit: z.limit, range: z.range });

/**
 * Odczyt po kluczu: COUNT tylko na pierwszej stronie, dalej `id > ostatnie id
 * poprzedniej strony` z `limit`, bez OFFSET; przy kilku stronach na końcu
 * jeden licznik kontrolny (`head`).
 */
function wzorPoKluczu(grupa: readonly Zapytanie[]): Ksztalt[] {
  const strony = grupa.filter((z) => !z.head);
  return [
    ...strony.map((_, i) => ({
      count: i === 0,
      head: false,
      poKluczu: i === 0 ? null : strony[i - 1]!.ostatnieId,
      limit: STRONA,
      range: null,
    })),
    ...(strony.length > 1 ? [{ count: true, head: true, poKluczu: null, limit: STRONA, range: null }] : []),
  ];
}

// ─── Dane ─────────────────────────────────────────────────────────────────

/**
 * Id jak UUID: rodzaj wiersza w pierwszym członie, numer przemieszany mnożeniem
 * (bijekcja modulo 2^32), więc kolejność `id` nie idzie za kolejnością dat.
 */
const uuid = (rodzaj: number, n: number) =>
  `${rodzaj.toString(16).padStart(8, '0')}-0000-4000-8000-${((n * 2654435761) >>> 0).toString(16).padStart(12, '0')}`;

const r2 = (x: number) => Math.round(x * 100) / 100;
const suma = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
const dzien = (rok: number, miesiac: number, d: number) =>
  `${rok}-${String(miesiac).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** Dzień `k` (od zera) liczony od 1 stycznia roku. */
const dzienRoku = (rok: number, k: number) => new Date(Date.UTC(rok, 0, 1 + k)).toISOString().slice(0, 10);

/** Fikcyjny NIP: 10 cyfr z celowo złą cyfrą kontrolną, więc żaden prawdziwy. */
function nip(k: number): string {
  const baza = `99${String(k).padStart(7, '0')}`;
  const wagi = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const kontrolna = [...baza].reduce((s, c, i) => s + Number(c) * wagi[i]!, 0) % 11;
  return `${baza}${(kontrolna + 1) % 10}`;
}

const STAWKI_RYCZALTU = [12, 8.5, 3, 15, 17, 5.5];
const KOLUMNY_KOSZTU = ['col_13', 'col_10', 'col_12', 'col_13', 'col_15'];
const STAWKI_EWIDENCJI_PB = [1200, 850, 300];

interface Rozmiar {
  sprzedazPazdziernik: number;
  sprzedazMarzec: number;
  pozycjeNaFakture: number;
  zakupy: number;
  kosztyPazdziernik: number;
  kosztyMaj: number;
  wpisyKpir: number;
  wpisyEwidencji: number;
  skladki: number;
  spisy: number;
}

/** Każdy z 12 odczytów stronami ma ponad 500 wierszy. */
const DUZA: Rozmiar = {
  sprzedazPazdziernik: 1101, sprzedazMarzec: 300, pozycjeNaFakture: 6, zakupy: 520,
  kosztyPazdziernik: 1101, kosztyMaj: 300, wpisyKpir: 520, wpisyEwidencji: 520, skladki: 612, spisy: 520,
};

/** Każdy odczyt mieści się na jednej stronie. */
const MALA: Rozmiar = {
  sprzedazPazdziernik: 12, sprzedazMarzec: 3, pozycjeNaFakture: 3, zakupy: 6,
  kosztyPazdziernik: 15, kosztyMaj: 4, wpisyKpir: 4, wpisyEwidencji: 4, skladki: 14, spisy: 2,
};

const liniaFa3 = (j: number, netto: number) => ({
  ordinal: j + 1, name: `Usługa ${j + 1}`, unit: 'szt.', quantity: j + 1,
  unitPriceNet: r2(netto / (j + 1)), netAmount: netto, vatRate: '23', vatAmount: r2(netto * 0.23),
});

function tabele(r: Rozmiar): Tables {
  const invoices: Row[] = [];
  const pozycje: Row[] = [];
  const expenses: Row[] = [];
  const wpisy: Row[] = [];
  const rozliczenia: Row[] = [];
  const spisy: Row[] = [];
  const wspolne = { origin: null, parent_invoice_id: null, correction_type: null, correction_reason: null, special_data: null };

  // Sprzedaż: październik i marzec; co 97. zaliczka, a po niej faktura rozliczająca (ROZ).
  for (let n = 0; n < r.sprzedazPazdziernik + r.sprzedazMarzec; n += 1) {
    const id = uuid(1, n);
    const wystawiona = n < r.sprzedazPazdziernik ? dzien(2026, 10, 1 + (n % 31)) : dzien(2026, 3, 1 + (n % 31));
    const rodzaj = n % 97 === 1 ? 'advance' : n % 97 === 2 ? 'final' : 'regular';
    const netto = Array.from({ length: r.pozycjeNaFakture }, (_, j) => r2((j + 1) * (10 + ((n * 7) % 300)) + ((n + j) % 100) / 100));
    const net = r2(suma(netto));
    const vat = r2(suma(netto.map((x) => r2(x * 0.23))));
    invoices.push({
      ...wspolne,
      id, tenant_id: FIRMA, direction: 'outgoing', ksef_status: 'accepted', ksef_environment: 'test',
      issue_date: wystawiona, sale_date: n % 4 === 0 ? dzien(2026, Number(wystawiona.slice(5, 7)), 1) : wystawiona,
      payment_due_date: wystawiona, internal_number: `FV/${n + 1}/2026`,
      ksef_number: `1234567890-${wystawiona.replaceAll('-', '')}-${id.slice(-12).toUpperCase()}-0A`,
      net_total: net, vat_total: vat, gross_total: r2(net + vat), advance_amount: rodzaj === 'advance' ? r2(net + vat) : null,
      buyer_data: { name: `Klient ${n % 37}`, nip: nip(n % 37), address: { addressLine1: `ul. Kupiecka ${n % 37}`, addressLine2: '00-950 Warszawa' } },
      buyer_nip: nip(n % 37), seller_data: null, seller_nip: '1234567890',
      invoice_kind: rodzaj, invoice_type: rodzaj === 'advance' ? 'ZAL' : rodzaj === 'final' ? 'ROZ' : 'VAT',
      advance_invoice_ids: rodzaj === 'final' ? [uuid(1, n - 1)] : null,
      currency: 'PLN',
      // Co 11. faktura ma pozycje w pliku FA(3): eksport bierze je stamtąd, nie z tabeli.
      fa3_data: n % 11 === 0 ? { lines: netto.map((x, j) => liniaFa3(j, x)) } : null,
    });
    netto.forEach((x, j) => pozycje.push({
      id: uuid(3, n * 10 + j), invoice_id: id, ordinal: j + 1, name: `Usługa ${j + 1}`, unit: 'szt.', quantity: j + 1,
      unit_price_net: r2(x / (j + 1)), net_amount: x, vat_rate: '23', vat_amount: r2(x * 0.23),
      ryczalt_rate: n % 10 === 0 ? null : STAWKI_RYCZALTU[(n + j) % STAWKI_RYCZALTU.length],
    }));
  }

  // Zakupy z KSeF (październik): połowa z pozycjami w pliku, połowa w tabeli.
  for (let n = 0; n < r.zakupy; n += 1) {
    const id = uuid(7, n);
    const wystawiona = dzien(2026, 10, 1 + (n % 31));
    const netto = [r2(50 + ((n * 11) % 700)), r2(5 + ((n * 3) % 90))];
    const net = r2(suma(netto));
    const vat = r2(suma(netto.map((x) => r2(x * 0.23))));
    invoices.push({
      ...wspolne,
      id, tenant_id: FIRMA, direction: 'incoming', ksef_status: 'accepted', ksef_environment: 'test',
      issue_date: wystawiona, sale_date: wystawiona, payment_due_date: wystawiona, internal_number: null,
      ksef_number: `${nip(100 + (n % 41))}-${wystawiona.replaceAll('-', '')}-${id.slice(-12).toUpperCase()}-1B`,
      net_total: net, vat_total: vat, gross_total: r2(net + vat), advance_amount: null,
      buyer_data: null, buyer_nip: '1234567890',
      seller_data: { name: `Dostawca ${n % 41}`, nip: nip(100 + (n % 41)) }, seller_nip: nip(100 + (n % 41)),
      invoice_kind: 'regular', invoice_type: 'VAT', advance_invoice_ids: null, currency: 'PLN',
      fa3_data: n % 2 === 0 ? { lines: netto.map((x, j) => liniaFa3(j, x)) } : null,
    });
    if (n % 2 === 1) {
      netto.forEach((x, j) => pozycje.push({
        id: uuid(8, n * 10 + j), invoice_id: id, ordinal: j + 1, name: `Towar ${j + 1}`, unit: 'szt.', quantity: j + 1,
        unit_price_net: r2(x / (j + 1)), net_amount: x, vat_rate: '23', vat_amount: r2(x * 0.23), ryczalt_rate: null,
      }));
    }
  }

  // Szum, którego żaden odczyt nie może wziąć: szkice i faktury innej firmy.
  for (let n = 0; n < 20; n += 1) {
    invoices.push({
      ...wspolne, id: uuid(11, n), tenant_id: FIRMA, direction: 'outgoing', ksef_status: 'draft', ksef_environment: null,
      issue_date: dzien(2026, 10, 1 + n), sale_date: dzien(2026, 10, 1 + n), internal_number: `SZKIC/${n}`, ksef_number: null,
      net_total: 100, vat_total: 23, gross_total: 123, buyer_data: null, invoice_kind: 'regular', invoice_type: 'VAT',
      advance_invoice_ids: null, currency: 'PLN', fa3_data: null,
    });
    invoices.push({
      ...wspolne, id: uuid(12, n), tenant_id: INNA_FIRMA, direction: n % 2 ? 'incoming' : 'outgoing', ksef_status: 'accepted',
      ksef_environment: 'production', issue_date: dzien(2026, 10, 1 + n), sale_date: dzien(2026, 10, 1 + n),
      internal_number: `OBCA/${n}`, ksef_number: `OBCA-${n}`, net_total: 100, vat_total: 23, gross_total: 123,
      buyer_data: null, invoice_kind: 'regular', invoice_type: 'VAT', advance_invoice_ids: null, currency: 'PLN', fa3_data: null,
    });
  }

  // Koszty: październik i maj; co 5. ze Skrzynki KSeF (z fakturą zakupu), co 23. bez „Uwzględnij w KPiR”.
  for (let e = 0; e < r.kosztyPazdziernik + r.kosztyMaj; e += 1) {
    const ksef = e % 5 === 0 && e / 5 < r.zakupy;
    const net = r2(20 + ((e * 13) % 2000) + (e % 100) / 100);
    const vat = r2(net * 0.23);
    expenses.push({
      id: uuid(2, e), tenant_id: FIRMA, is_deductible: e % 23 !== 0,
      issue_date: e < r.kosztyPazdziernik ? dzien(2026, 10, 1 + (e % 31)) : dzien(2026, 5, 1 + (e % 31)),
      source: ksef ? 'ksef_inbox' : e % 7 === 0 ? 'ocr_photo' : 'manual',
      ksef_invoice_id: ksef ? uuid(7, e / 5) : null,
      document_number: `K/${e + 1}/2026`, document_type: 'invoice',
      seller_name: `Dostawca ${e % 41}`, seller_nip: nip(100 + (e % 41)), seller_address: 'ul. Hurtowa 2, 00-950 Warszawa',
      net_amount: net, vat_amount: vat, gross_amount: r2(net + vat), vat_deductible_amount: e % 9 === 0 ? r2(vat / 2) : vat,
      kpir_column: KOLUMNY_KOSZTU[e % KOLUMNY_KOSZTU.length], category_label: e % 50 === 7 ? 'Reprezentacja' : 'Materiały',
      is_reviewed: true, ocr_extracted_data: null,
    });
  }
  for (let e = 0; e < 20; e += 1) {
    expenses.push({
      id: uuid(13, e), tenant_id: INNA_FIRMA, is_deductible: true, issue_date: dzien(2026, 10, 1 + e), source: 'manual',
      ksef_invoice_id: null, document_number: `OBCY/${e}`, document_type: 'invoice', seller_name: 'Obcy', seller_nip: null,
      seller_address: null, net_amount: 1, vat_amount: 0, gross_amount: 1, vat_deductible_amount: 0, kpir_column: 'col_13',
      category_label: null, is_reviewed: true, ocr_extracted_data: null,
    });
  }

  // Wpisy ręczne: KPiR (kolumna) i ewidencja (stawka), plus wpisy z 2025 r. i innej firmy.
  for (let w = 0; w < r.wpisyKpir; w += 1) {
    const d = dzienRoku(2026, w % 365);
    wpisy.push({
      id: uuid(4, w), tenant_id: FIRMA, rodzaj: w % 3 === 0 ? 'inny' : 'raport_kasy', data_przychodu: d, data_wpisu: d,
      dokument: `RK/${w + 1}`, kwota_gr: 10_000 + ((w * 37) % 50_000), kolumna: w % 3 === 0 ? 'k8' : 'k7', stawka_pb: null,
      opis: w % 4 === 0 ? `Wpis ${w}` : null,
    });
  }
  for (let w = 0; w < r.wpisyEwidencji; w += 1) {
    const d = dzienRoku(2026, w % 365);
    wpisy.push({
      id: uuid(5, w), tenant_id: FIRMA, rodzaj: w % 3 === 0 ? 'inny' : 'raport_kasy', data_przychodu: d, data_wpisu: d,
      dokument: `RKE/${w + 1}`, kwota_gr: 20_000 + ((w * 41) % 60_000), kolumna: null,
      stawka_pb: STAWKI_EWIDENCJI_PB[w % STAWKI_EWIDENCJI_PB.length], opis: null,
    });
  }
  for (let w = 0; w < 10; w += 1) {
    wpisy.push({
      id: uuid(14, w), tenant_id: w % 2 ? INNA_FIRMA : FIRMA, rodzaj: 'raport_kasy', data_przychodu: dzien(2025, 12, 1 + w),
      data_wpisu: dzien(2025, 12, 1 + w), dokument: `STARY/${w}`, kwota_gr: 1_000, kolumna: w % 4 < 2 ? 'k7' : null,
      stawka_pb: w % 4 < 2 ? null : 1200, opis: null,
    });
  }

  // Zapłacone składki społeczne: po jednym miesiącu wstecz od grudnia 2026, co 50. z dopłatą (wersja 2).
  for (let m = 0; m < r.skladki; m += 1) {
    const indeks = 2026 * 12 + 11 - (r.skladki - 1 - m);
    const rok = Math.floor(indeks / 12);
    const miesiac = (indeks % 12) + 1;
    const okres = dzien(rok, miesiac, 1);
    rozliczenia.push({
      id: uuid(6, m), tenant_id: FIRMA, rodzaj: 'zus_spoleczne', status: 'zaplacone', okres, wersja: 1,
      kwota_gr: 150_000 + m, zaplacone_o: dzien(rok, miesiac, 15), migawka: { spoleczneBezFpGr: 140_000 + m },
    });
    if (m % 50 === 0) {
      rozliczenia.push({
        id: uuid(9, m), tenant_id: FIRMA, rodzaj: 'zus_spoleczne', status: 'zaplacone', okres, wersja: 2,
        kwota_gr: 151_000 + m, zaplacone_o: dzien(rok, miesiac, 20), migawka: { spoleczneBezFpGr: 140_400 + m },
      });
    }
  }
  for (let m = 0; m < 6; m += 1) {
    rozliczenia.push({
      id: uuid(15, m), tenant_id: m === 5 ? INNA_FIRMA : FIRMA, rodzaj: m % 2 ? 'zus_spoleczne' : 'pit',
      status: m % 2 ? 'zatwierdzone' : 'zaplacone', okres: dzien(2026, 1 + m, 1), wersja: 1, kwota_gr: 99_999,
      zaplacone_o: dzien(2026, 1 + m, 15), migawka: { spoleczneBezFpGr: 1 },
    });
  }

  // Spisy z natury od 31 grudnia 2025 do 31 grudnia 2026 (w dużej firmie po kilka na dzień) i poza okresem.
  for (let s = 0; s < r.spisy; s += 1) {
    spisy.push({ id: uuid(10, s), tenant_id: FIRMA, data: dzienRoku(2025, 364 + (s % 366)), kwota_gr: 500_000 + s * 10, opis: s % 2 ? 'Remanent' : null });
  }
  for (const [s, data] of ['2025-12-30', '2027-01-01'].entries()) {
    spisy.push({ id: uuid(16, s), tenant_id: FIRMA, data, kwota_gr: 1, opis: null });
  }
  spisy.push({ id: uuid(16, 9), tenant_id: INNA_FIRMA, data: '2026-06-30', kwota_gr: 1, opis: null });

  return {
    tenants: [{
      id: FIRMA, nip: '1234567890', name: 'Firma Testowa sp. z o.o.',
      address_json: { addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa', countryCode: 'PL' },
    }],
    invoices,
    invoice_line_items: pozycje,
    expenses,
    ledger_manual_entries: wpisy,
    tax_settlements: rozliczenia,
    ledger_inventory_counts: spisy,
  };
}

const SKALA: WersjaProfilu = {
  id: 'p-skala', validFrom: '2026-01-01', forma: 'skala', stawkaDomyslna: null,
  zusEtap: 'pelny', zusOd: null, chorobowe: false, nrsZus: null, najem: false,
};
const RYCZALT: WersjaProfilu = { ...SKALA, id: 'p-ryczalt', forma: 'ryczalt', stawkaDomyslna: 1200 };
/** Same złotówki: kurs NBP niepotrzebny, a wywołanie byłoby błędem testu. */
const bezKursu = async (): Promise<never> => {
  throw new Error('test: kurs NBP niepotrzebny');
};

// ─── Wejścia ──────────────────────────────────────────────────────────────

const WEJSCIA = {
  'raport KPiR (getKpirData)': (klient: unknown) =>
    getKpirData(klient as PageContext['supabase'], FIRMA, { month: '10', year: '2026' }, NOW),
  'eksport (fetchInvoicesForExport)': (klient: unknown) =>
    fetchInvoicesForExport(
      { tenantId: FIRMA, periodStart: '2026-10-01', periodEnd: '2026-10-31', direction: 'both', includeExpenses: true },
      klient as Parameters<typeof fetchInvoicesForExport>[1],
    ),
  'KPiR modułu (czytajKpir)': (klient: unknown) =>
    czytajKpir(klient as SupabaseClient, FIRMA, 2026, { wersje: [SKALA], kurs: bezKursu }),
  'ewidencja przychodów (czytajEwidencje)': (klient: unknown) =>
    czytajEwidencje(klient as SupabaseClient, FIRMA, 2026, { wersje: [RYCZALT], kurs: bezKursu }),
} as const;

type Wejscie = keyof typeof WEJSCIA;

const SCENARIUSZE = [
  { nazwa: 'duża firma: każdy odczyt na 2–3 stronach', rozmiar: DUZA },
  { nazwa: 'mała firma: każdy odczyt na jednej stronie', rozmiar: MALA },
] as const;

/** Mapy i zbiory jako tablice: wynik ma się zgadzać co do kolejności i treści. */
const kanon = (v: unknown) =>
  JSON.stringify(v, (_k, w: unknown) => (w instanceof Map ? { mapa: [...w.entries()] } : w instanceof Set ? { zbior: [...w] } : w));

/** Kilka liczb do podglądu wzorca: długości tablic i wartości proste do dwóch poziomów. */
function liczby(v: unknown, prefiks = '', wynik: Record<string, unknown> = {}, glebokosc = 0): Record<string, unknown> {
  if (Array.isArray(v)) wynik[prefiks] = v.length;
  else if (v instanceof Map) wynik[prefiks] = v.size;
  else if (v && typeof v === 'object') {
    if (glebokosc < 2) {
      for (const [k, w] of Object.entries(v)) liczby(w, prefiks ? `${prefiks}.${k}` : k, wynik, glebokosc + 1);
    }
  } else wynik[prefiks] = v ?? null;
  return wynik;
}

async function uruchom(rozmiar: Rozmiar) {
  const dane = tabele(rozmiar);
  const wyniki = {} as Record<Wejscie, { liczby: Record<string, unknown>; sha256: string; znaki: number }>;
  const logi = {} as Record<Wejscie, Zapytanie[]>;
  for (const [nazwa, wejscie] of Object.entries(WEJSCIA) as Array<[Wejscie, (klient: unknown) => Promise<unknown>]>) {
    const log: Zapytanie[] = [];
    let wynik: unknown;
    try {
      wynik = await wejscie(liczacyKlient(dane, log));
    } catch (e) {
      wynik = { blad: e instanceof Error ? e.message : String(e) };
    }
    const tekst = kanon(wynik);
    wyniki[nazwa] = { liczby: liczby(wynik), sha256: createHash('sha256').update(tekst).digest('hex'), znaki: tekst.length };
    logi[nazwa] = log;
  }
  return { wyniki, logi };
}

/** Wzorzec z dysku; `null`, gdy go jeszcze nie ma (pierwszy zapis). */
function wczytajWzorzec(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(WZORZEC, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const CZAS = 120_000;

describe('złoty wzorzec: wyniki KPiR i eksportów identyczne jak przed sesją 33', () => {
  it.each(SCENARIUSZE.map((s) => [s.nazwa, s] as const))('%s', async (_nazwa, s) => {
    const { wyniki } = await uruchom(s.rozmiar);
    if (process.env.KPIR_WZORZEC === 'zapisz') {
      const wzorzec = wczytajWzorzec() ?? {};
      wzorzec[s.nazwa] = wyniki;
      writeFileSync(WZORZEC, `${JSON.stringify(wzorzec, null, 1)}\n`);
      return;
    }
    const wzorzec = wczytajWzorzec();
    expect(wzorzec?.[s.nazwa], `brak scenariusza „${s.nazwa}” we wzorcu`).toBeDefined();
    expect(wyniki).toEqual(wzorzec![s.nazwa]);
  }, CZAS);

  it('duża firma: wzorzec to policzone księgi i pełny eksport, a nie komunikat błędu', async () => {
    const { wyniki } = await uruchom(DUZA);
    const raport = wyniki['raport KPiR (getKpirData)'].liczby;
    expect(raport).toMatchObject({ currencyBlocked: null, settledError: null });
    expect(raport.expenses).toBeGreaterThan(1000);
    expect(raport.invoices).toBe(DUZA.sprzedazPazdziernik);
    expect(wyniki['eksport (fetchInvoicesForExport)'].liczby).toMatchObject({
      issuedInvoices: DUZA.sprzedazPazdziernik,
      receivedInvoices: DUZA.zakupy,
    });
    expect(wyniki['eksport (fetchInvoicesForExport)'].liczby.expenses).toBeGreaterThan(1000);
    expect(wyniki['KPiR modułu (czytajKpir)'].liczby).toMatchObject({ ok: true, wpisy: DUZA.wpisyKpir, spisy: DUZA.spisy });
    expect(wyniki['KPiR modułu (czytajKpir)'].liczby['kpir.wiersze']).toBeGreaterThan(3000);
    expect(wyniki['ewidencja przychodów (czytajEwidencje)'].liczby).toMatchObject({ ok: true, wpisy: DUZA.wpisyEwidencji });
    expect(wyniki['ewidencja przychodów (czytajEwidencje)'].liczby['ewidencja.wiersze']).toBeGreaterThan(1500);
  }, CZAS);
});

describe('QRY-07: KPiR i eksporty czytają po kluczu (COUNT na pierwszej stronie i raz na końcu, bez OFFSET)', () => {
  /**
   * Odczyty z więcej niż jedną stroną danych, po tabelach (duża firma), z pomiaru
   * na kodzie sprzed sesji 33. Gdy liczba spadnie, test przestaje sprawdzać część
   * odczytów, więc zmiana danych testu wymaga świadomej zmiany tych liczb.
   */
  const WIELE_STRON: Record<Wejscie, Record<string, number>> = {
    'raport KPiR (getKpirData)': { expenses: 1, invoices: 1 },
    // Pozycje sprzedaży: 10 paczek po 100 faktur bez pozycji w pliku FA(3), po 600 wierszy;
    // trzy paczki zakupów (po 2 pozycje) mieszczą się na jednej stronie.
    'eksport (fetchInvoicesForExport)': { expenses: 1, invoices: 2, invoice_line_items: 10 },
    // Pozycje ewidencji: paczki po 100 faktur, najpierw pozycje ze stawką (14 z 15 paczek na dwóch
    // stronach), potem wszystkie pozycje faktur z choć jedną stawką (12 z 13).
    'KPiR modułu (czytajKpir)': {
      expenses: 1, invoices: 1, invoice_line_items: 26, ledger_inventory_counts: 1, ledger_manual_entries: 1, tax_settlements: 1,
    },
    'ewidencja przychodów (czytajEwidencje)': { invoices: 1, invoice_line_items: 26, ledger_manual_entries: 1 },
  };

  it('duża firma: każdy odczyt stronami idzie po kluczu, z jednym licznikiem kontrolnym', async () => {
    const { logi } = await uruchom(DUZA);
    for (const [wejscie, log] of Object.entries(logi) as Array<[Wejscie, Zapytanie[]]>) {
      const odczyty = odczytyStronami(log);
      for (const grupa of odczyty) {
        const opis = `${wejscie}: ${grupa[0]!.tabela} (${grupa[0]!.kolumny.slice(0, 40)}…)`;
        expect(grupa.map(ksztalt), opis).toEqual(wzorPoKluczu(grupa));
        // Tyle stron, ile wynika z licznika pierwszej strony.
        expect(grupa.filter((z) => !z.head), opis).toHaveLength(Math.max(1, Math.ceil(grupa[0]!.licznik! / STRONA)));
      }
      const wieleStron: Record<string, number> = {};
      for (const grupa of odczyty.filter((g) => g.filter((z) => !z.head).length > 1)) {
        wieleStron[grupa[0]!.tabela] = (wieleStron[grupa[0]!.tabela] ?? 0) + 1;
      }
      expect(wieleStron, wejscie).toEqual(WIELE_STRON[wejscie]);
    }
  }, CZAS);

  it('mała firma: jedna strona to jedno zapytanie z COUNT, bez licznika kontrolnego', async () => {
    const { logi } = await uruchom(MALA);
    for (const [wejscie, log] of Object.entries(logi) as Array<[Wejscie, Zapytanie[]]>) {
      const odczyty = odczytyStronami(log);
      expect(odczyty.length, wejscie).toBeGreaterThan(0);
      for (const grupa of odczyty) {
        expect(grupa.map(ksztalt), `${wejscie}: ${grupa[0]!.tabela}`)
          .toEqual([{ count: true, head: false, poKluczu: null, limit: STRONA, range: null }]);
      }
    }
  }, CZAS);
});

describe('bezpieczniki zostają: zapis w trakcie odczytu kilku stron', () => {
  /** Druga strona odczytu: po kluczu albo OFFSET od 500 (kod sprzed sesji 33). */
  const drugaStrona = (z: Zapytanie) => czyStronami(z) && (z.poKluczu !== null || (z.range !== null && z.range[0] > 0));
  /** Wiersz z najmniejszym `id`: odczyt po kluczu już go nie zobaczy, zobaczy go tylko licznik. */
  const PIERWSZE_ID = '00000000-0000-4000-8000-000000000000';

  async function zZapisem(wejscie: Wejscie, kiedy: (z: Zapytanie) => boolean, dopisz: (t: Tables) => void) {
    const dane = tabele(DUZA);
    let dopisany = false;
    const klient = liczacyKlient(dane, [], {
      przed: (z, t) => {
        if (dopisany || !kiedy(z)) return;
        dopisany = true;
        dopisz(t);
      },
    });
    const wynik = await WEJSCIA[wejscie](klient).then((w) => w, (e: unknown) => ({ blad: e instanceof Error ? e.message : String(e) }));
    expect(dopisany).toBe(true);
    return wynik;
  }

  const nowyKoszt = (t: Tables) => {
    const wzor = t.expenses!.find((e) => e.tenant_id === FIRMA && e.is_deductible === true && e.source === 'manual')!;
    t.expenses!.push({ ...wzor, id: PIERWSZE_ID, document_number: 'K/DOPISANY' });
  };

  it('raport KPiR: koszt dopisany po pierwszej stronie zatrzymuje raport', async () => {
    const wynik = await zZapisem('raport KPiR (getKpirData)', (z) => z.tabela === 'expenses' && drugaStrona(z), nowyKoszt);
    expect(wynik).toEqual({ blad: 'expenses: nie można potwierdzić liczby rekordów' });
  }, CZAS);

  it('eksport: koszt dopisany po pierwszej stronie zatrzymuje eksport', async () => {
    const wynik = await zZapisem('eksport (fetchInvoicesForExport)', (z) => z.tabela === 'expenses' && drugaStrona(z), nowyKoszt);
    expect(wynik).toEqual({ blad: 'expenses: nie można potwierdzić liczby rekordów' });
  }, CZAS);

  it('KPiR modułu: wpis dopisany po pierwszej stronie to komunikat odczytu, nie księga bez wpisu', async () => {
    const wynik = await zZapisem(
      'KPiR modułu (czytajKpir)',
      (z) => z.tabela === 'ledger_manual_entries' && drugaStrona(z),
      (t) => {
        const wzor = t.ledger_manual_entries!.find((w) => w.tenant_id === FIRMA && w.kolumna === 'k7')!;
        t.ledger_manual_entries!.push({ ...wzor, id: PIERWSZE_ID, dokument: 'RK/DOPISANY' });
      },
    );
    expect(wynik).toEqual({ ok: false, komunikat: KOMUNIKAT_ODCZYT });
    expect(vi.mocked(console.error).mock.calls).toContainEqual(['[kpir] odczyt', 'kpir: wpisy ręczne: nie można potwierdzić liczby rekordów']);
  }, CZAS);

  it('ewidencja: faktura dopisana po pierwszej stronie to komunikat odczytu', async () => {
    const wynik = await zZapisem(
      'ewidencja przychodów (czytajEwidencje)',
      (z) => z.tabela === 'invoices' && drugaStrona(z),
      (t) => {
        const wzor = t.invoices!.find((f) => f.tenant_id === FIRMA && f.direction === 'outgoing' && f.ksef_status === 'accepted')!;
        t.invoices!.push({ ...wzor, id: PIERWSZE_ID, internal_number: 'FV/DOPISANA/2026' });
      },
    );
    expect(wynik).toEqual({ ok: false, komunikat: KOMUNIKAT_ODCZYT });
    expect(vi.mocked(console.error).mock.calls).toContainEqual(['[ewidencja] odczyt', 'ewidencja: faktury: nie można potwierdzić liczby rekordów']);
  }, CZAS);
});

describe('pomiar zapytań (do opisu PR)', () => {
  // Tylko na żądanie: KPIR_POMIAR=ścieżka zapisuje liczniki dużej firmy do pliku.
  it.runIf(Boolean(process.env.KPIR_POMIAR))('liczniki odczytów stronami', async () => {
    const { logi } = await uruchom(DUZA);
    const tabela = Object.fromEntries(Object.entries(logi).map(([wejscie, log]) => {
      const stronami = log.filter(czyStronami);
      const wieleStron: Record<string, number> = {};
      for (const grupa of odczytyStronami(log).filter((g) => g.filter((z) => !z.head).length > 1)) {
        wieleStron[grupa[0]!.tabela] = (wieleStron[grupa[0]!.tabela] ?? 0) + 1;
      }
      return [wejscie, {
        'odczyty stronami': odczytyStronami(log).length,
        'odczyty z kilkoma stronami': wieleStron,
        'zapytania stronami': stronami.length,
        'z COUNT': stronami.filter((z) => z.count).length,
        'przewinięte OFFSET-em wiersze': suma(stronami.map((z) => z.range?.[0] ?? 0)),
        'wszystkie zapytania': log.length,
      }];
    }));
    writeFileSync(process.env.KPIR_POMIAR!, `${JSON.stringify(tabela, null, 1)}\n`);
    expect(Object.keys(tabela)).toHaveLength(4);
  }, CZAS);
});
