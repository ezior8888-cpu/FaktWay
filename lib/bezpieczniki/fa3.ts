/**
 * Strażnik FA(3) przed wysyłką do KSeF (żelazny filtr F13 część 4, plan
 * B4.10). D-F7: dla faktur najpierw tylko alarm przez 2 tygodnie, blokada
 * dopiero za zgodą Bartosza. `submitInvoiceFull`
 * (`lib/ksef/submit-invoice-full.ts`) woła `alarmujFa3` po kontroli XSD:
 * alarm `FILTR-RT-FA3-*` trafia do Sentry (`alarm.ts`), a faktura idzie do
 * KSeF jak dotąd.
 *
 * Funkcja czysta nad tekstem XML (parser `fast-xml-parser`, jak strażnik
 * JPK_V7M). Kwoty w groszach jako liczby całkowite `bigint` (typ TKwotowy
 * ma do 16 cyfr przed przecinkiem); pola nie ma, to 0. Pole powtórzone,
 * puste, z przecinkiem albo z więcej niż dwoma miejscami po przecinku to
 * błąd kontroli, która go potrzebuje. Typy i kolejność pól sprawdza XSD
 * przed strażnikiem.
 *
 * Wzory z opisów pól schematu MF (`lib/xml/schemas/fa3/schemat.xsd`) i z
 * rejestru (`filtr/przepisy/faktury.json`), nie z kodu generatorów:
 * - FILTR-RT-FA3-01 (NZ-FA-01; RP-FA-SUMY-01, RP-FA-KOR-01, RP-FA-ZAL-01,
 *   RP-FA-ROZ-01): P_15 to suma P_13_x i P_14_x wszystkich stawek. P_14_xW
 *   (podatek przeliczony na złote przy walucie obcej) nie wchodzi do sumy.
 * - FILTR-RT-FA3-02 (NZ-FA-02, RP-FA-SUMY-01): faktura VAT: suma P_11
 *   pozycji w stawce równa się P_13_x tej stawki. Stawki z opisów pól: P_13_1
 *   23 albo 22 %, P_13_2 8 albo 7 %, P_13_3 5 %, P_13_6_1 „0 KR”, P_13_6_2
 *   „0 WDT”, P_13_6_3 „0 EX”, P_13_7 „zw”, P_13_8 „np I”, P_13_9 „np II”,
 *   P_13_10 „oo”. Pozycja z inną stawką (ryczałt taksówek, OSS, marża) albo
 *   bez P_11 (np. P_11A przy fakturze od brutto) wyłącza kontrole 02 i 03
 *   dla tej faktury: wzoru nie da się wtedy sprawdzić z samego pliku.
 * - FILTR-RT-FA3-03 (NZ-FA-02, NZ-ZAOKR-06): faktura VAT: P_14_x różni się od
 *   P_13_x razy stawka najwyżej o pół grosza na pozycję w tej stawce. Tyle
 *   daje zaokrąglenie podatku każdej pozycji osobno; podatek od sumy w
 *   stawce mieści się tym bardziej, więc kontrola nie rozstrzyga metody.
 * - FILTR-RT-FA3-04 (NZ-FA-03): pozycja zwolniona („zw” w P_12 albo P_12Z)
 *   wymaga P_19 = 1 z podstawą zwolnienia (P_19A, P_19B albo P_19C), a w
 *   fakturze VAT także odwrotnie. Pozycja „oo” albo „np II” wymaga P_18 = 1
 *   (opis P_18: podatek rozlicza nabywca). Stawkę z podatkiem u firmy
 *   zwolnionej z art. 113 zatrzymuje wcześniej kolejka wysyłki
 *   (`taxedRateUnderSubjectiveExemption`, F12-G6b).
 */

import { XMLParser } from 'fast-xml-parser';

import { zglosAlarmy, type AlarmFiltra } from '@/lib/bezpieczniki/alarm';

export const KODY_FA3 = {
  suma: 'FILTR-RT-FA3-01',
  pozycje: 'FILTR-RT-FA3-02',
  podatek: 'FILTR-RT-FA3-03',
  oznaczenia: 'FILTR-RT-FA3-04',
} as const;

export type KodFa3 = (typeof KODY_FA3)[keyof typeof KODY_FA3];

export interface AlarmFa3 extends AlarmFiltra {
  kod: KodFa3;
}

/** Pole P_13_x i jego stawki P_12 z opisów pól schematu; `procent` dla stawek z podatkiem (P_14_x). */
export const STAWKI_FA3 = [
  { netto: 'P_13_1', podatek: 'P_14_1', stawki: ['23', '22'] },
  { netto: 'P_13_2', podatek: 'P_14_2', stawki: ['8', '7'] },
  { netto: 'P_13_3', podatek: 'P_14_3', stawki: ['5'] },
  { netto: 'P_13_6_1', stawki: ['0 KR'] },
  { netto: 'P_13_6_2', stawki: ['0 WDT'] },
  { netto: 'P_13_6_3', stawki: ['0 EX'] },
  { netto: 'P_13_7', stawki: ['zw'] },
  { netto: 'P_13_8', stawki: ['np I'] },
  { netto: 'P_13_9', stawki: ['np II'] },
  { netto: 'P_13_10', stawki: ['oo'] },
] as const;

/** Wszystkie pola sumy P_15 (NZ-FA-01): P_13_x i P_14_x według kolejności w schemacie. */
export const POLA_SUMY_P15 = [
  'P_13_1', 'P_14_1', 'P_13_2', 'P_14_2', 'P_13_3', 'P_14_3', 'P_13_4', 'P_14_4', 'P_13_5', 'P_14_5',
  'P_13_6_1', 'P_13_6_2', 'P_13_6_3', 'P_13_7', 'P_13_8', 'P_13_9', 'P_13_10', 'P_13_11',
] as const;

const ODWROTNE = new Set(['oo', 'np II']);

type Wezel = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Wartości jako tekst: kwoty czyta `grosze`, nie parser (jak w `lib/import/fa3-parser.ts`).
  parseTagValue: false,
  trimValues: true,
  isArray: (nazwa) => nazwa === 'FaWiersz' || nazwa === 'ZamowienieWiersz',
});

const KWOTA = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;
const ZERO = BigInt(0);
const JEDEN = BigInt(1);
const PIECDZIESIAT = BigInt(50);
const STO = BigInt(100);

/** Kwota TKwotowy w groszach; `null`, gdy pole nie jest pojedynczą kwotą. Brak pola to 0. */
function grosze(wezel: Wezel | null, pole: string): bigint | null {
  const wartosc = wezel?.[pole];
  if (wartosc === undefined) return ZERO;
  if (typeof wartosc !== 'string') return null;
  const m = KWOTA.exec(wartosc);
  if (!m) return null;
  const wynik = BigInt(m[2] ?? '0') * STO + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -wynik : wynik;
}

function wezel(wartosc: unknown): Wezel | null {
  return wartosc !== null && typeof wartosc === 'object' && !Array.isArray(wartosc) ? (wartosc as Wezel) : null;
}

function wiersze(wartosc: unknown): Wezel[] {
  return Array.isArray(wartosc) ? wartosc.map(wezel).filter((w): w is Wezel => w !== null) : [];
}

function tekst(w: Wezel | null, pole: string): string | null {
  const wartosc = w?.[pole];
  return typeof wartosc === 'string' ? wartosc : null;
}

function odczytaj(xml: string): Wezel | null {
  try {
    return wezel(parser.parse(xml));
  } catch {
    return null;
  }
}

/** Sprawdza gotowy plik; pusta lista to plik w porządku. */
export function sprawdzFa3(xml: string): AlarmFa3[] {
  const fa = wezel(wezel(odczytaj(xml)?.Faktura)?.Fa);
  const rodzaj = (tekst(fa, 'RodzajFaktury') ?? 'nieznany').toLowerCase();
  const miesiac = /^\d{4}-\d{2}/.exec(tekst(fa, 'P_1') ?? '')?.[0] ?? 'brak';
  const alarmy: AlarmFa3[] = [];
  const zglos = (kod: KodFa3, opis: string) => alarmy.push({ kod, rodzaj, miesiac, opis });

  if (!fa) {
    zglos(KODY_FA3.suma, 'plik nie ma węzła Faktura/Fa');
    return alarmy;
  }

  sprawdzSume(fa, zglos);
  const pozycje = wiersze(fa.FaWiersz);
  if (rodzaj === 'vat') sprawdzPozycje(fa, pozycje, zglos);
  sprawdzOznaczenia(fa, rodzaj, pozycje, zglos);
  return alarmy;
}

type Zglos = (kod: KodFa3, opis: string) => void;

function sprawdzSume(fa: Wezel, zglos: Zglos): void {
  const p15 = grosze(fa, 'P_15');
  if (p15 === null || fa.P_15 === undefined) return zglos(KODY_FA3.suma, 'pole P_15 nie jest kwotą albo go brak');
  let suma = ZERO;
  for (const pole of POLA_SUMY_P15) {
    const gr = grosze(fa, pole);
    if (gr === null) return zglos(KODY_FA3.suma, `pole ${pole} nie jest kwotą albo występuje więcej niż raz`);
    suma += gr;
  }
  if (suma !== p15) zglos(KODY_FA3.suma, 'P_15 różni się od sumy pól P_13_x i P_14_x');
}

function sprawdzPozycje(fa: Wezel, pozycje: Wezel[], zglos: Zglos): void {
  const sumy = new Map<string, { netto: bigint; ile: bigint }>();
  for (const pozycja of pozycje) {
    const stawka = tekst(pozycja, 'P_12');
    const pole = STAWKI_FA3.find((s) => (s.stawki as readonly string[]).includes(stawka ?? ''));
    const netto = pozycja.P_11 === undefined ? null : grosze(pozycja, 'P_11');
    // Stawka spoza listy albo pozycja bez P_11: wzoru nie da się sprawdzić z pliku.
    if (!pole || netto === null) return;
    const dotad = sumy.get(pole.netto) ?? { netto: ZERO, ile: ZERO };
    sumy.set(pole.netto, { netto: dotad.netto + netto, ile: dotad.ile + JEDEN });
  }
  for (const pole of STAWKI_FA3) {
    const p13 = grosze(fa, pole.netto);
    const zPozycji = sumy.get(pole.netto) ?? { netto: ZERO, ile: ZERO };
    if (p13 === null) {
      zglos(KODY_FA3.pozycje, `pole ${pole.netto} nie jest kwotą albo występuje więcej niż raz`);
      continue;
    }
    if (p13 !== zPozycji.netto) zglos(KODY_FA3.pozycje, `${pole.netto} różni się od sumy P_11 pozycji w tej stawce`);
    if (!('podatek' in pole)) continue;
    const p14 = grosze(fa, pole.podatek);
    if (p14 === null) {
      zglos(KODY_FA3.podatek, `pole ${pole.podatek} nie jest kwotą albo występuje więcej niż raz`);
      continue;
    }
    // Stawka liczbowa pozycji tej grupy: P_13_1 to 23 albo 22 %; plik ma jedną z nich.
    const procenty = new Set(pozycje.filter((p) => (pole.stawki as readonly string[]).includes(tekst(p, 'P_12') ?? '')).map((p) => tekst(p, 'P_12')));
    if (procenty.size > 1) {
      zglos(KODY_FA3.podatek, `pozycje w ${pole.netto} mają różne stawki`);
      continue;
    }
    const procent = BigInt([...procenty][0] ?? pole.stawki[0]);
    // |P_14 − P_13 × stawka| ≤ pół grosza na pozycję, w setnych grosza: |100·P_14 − P_13·procent| ≤ 50·ile.
    const roznica = STO * p14 - p13 * procent;
    if ((roznica < ZERO ? -roznica : roznica) > PIECDZIESIAT * zPozycji.ile) {
      zglos(KODY_FA3.podatek, `${pole.podatek} nie zgadza się z ${pole.netto} i stawką (więcej niż zaokrąglenie pozycji)`);
    }
  }
}

function sprawdzOznaczenia(fa: Wezel, rodzaj: string, pozycje: Wezel[], zglos: Zglos): void {
  const adnotacje = wezel(fa.Adnotacje);
  const zwolnienie = wezel(adnotacje?.Zwolnienie);
  const stawki = [
    ...pozycje.map((p) => tekst(p, 'P_12')),
    ...wiersze(wezel(fa.Zamowienie)?.ZamowienieWiersz).map((p) => tekst(p, 'P_12Z')),
  ].filter((s): s is string => s !== null);

  const p19 = tekst(zwolnienie, 'P_19') === '1';
  const podstawa = ['P_19A', 'P_19B', 'P_19C'].map((pole) => tekst(zwolnienie, pole)).find((t) => t !== null && t.trim() !== '') ?? null;
  const zwolnione = stawki.includes('zw');
  if (zwolnione && (!p19 || podstawa === null)) zglos(KODY_FA3.oznaczenia, 'pozycja zwolniona bez P_19 = 1 i podstawy zwolnienia');
  if (rodzaj === 'vat' && p19 && !zwolnione) zglos(KODY_FA3.oznaczenia, 'P_19 = 1 bez pozycji zwolnionej');
  if (stawki.some((s) => ODWROTNE.has(s)) && tekst(adnotacje, 'P_18') !== '1') {
    zglos(KODY_FA3.oznaczenia, 'pozycja „oo” albo „np II” bez P_18 = 1');
  }
}

/**
 * Tryb „tylko alarm” (D-F7): alarmy do Sentry, wysyłka idzie dalej. Błąd
 * samego strażnika trafia tylko do logu, nigdy nie zatrzymuje faktury.
 */
export function alarmujFa3(xml: string, tenantId: string): AlarmFa3[] {
  try {
    const alarmy = sprawdzFa3(xml);
    if (alarmy.length > 0) zglosAlarmy(alarmy, { tenantId, straznik: 'fa3' });
    return alarmy;
  } catch (e) {
    console.error('[FILTR-RT] strażnik FA(3) nie zadziałał', e instanceof Error ? e.message : String(e));
    return [];
  }
}
