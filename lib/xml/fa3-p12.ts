/**
 * Stawka VAT pozycji FA(3) (`P_12`, typ `TStawkaPodatku`) ↔ stawka FaktWay
 * (`VatRate`) — W9 z planu „zero zgubionych faktur” (sesja C5a).
 *
 * Generatory FaktWay (fa3-generator, korekty, zaliczki/ROZ) zapisują 8 stawek
 * jako P_12: „23”, „8”, „5”, „0 KR”, „zw”, „oo”, „np I”, „np II”. Import
 * historii z KSeF zapisywał P_12 dosłownie, więc faktura z „0 KR” czy „np II”
 * miała w bazie stawkę, której eksporty nie znają — JPK_FA i JPK_V7M padały na
 * całym miesiącu. Tu jedno odwzorowanie odwrotne.
 *
 * Kody FA(3) bez odpowiednika w FaktWay („0 WDT”, „0 EX”, „22”, „7” i ryczałt
 * taksówek „4”/„3”) zapisujemy DOSŁOWNIE: zamiana na „0” albo „23” przekłamałaby
 * JPK_V7M (WDT i eksport mają własne pola) i wyliczony VAT. JPK odmawia wtedy
 * z nazwą dokumentu (`JpkDocumentNotSupportedError`). Pozycja bez P_12 dostaje
 * stawkę z nagłówka tylko wtedy, gdy wynika z niego jednoznacznie — inaczej
 * „nieznana” (nigdy domyślne 23%).
 *
 * CZYSTY moduł: bez Node, bazy i XML — tylko wartości.
 */

import type { VatRate } from '@/types/invoice';

const VAT_RATE_SET: Readonly<Record<VatRate, true>> = {
  '23': true, '8': true, '5': true, '0': true, zw: true, oo: true, np: true, np_ii: true,
};

/** Stawki FaktWay (lustro `VatRate`, kompletność pilnuje `Record`). */
export const VAT_RATES = Object.keys(VAT_RATE_SET) as readonly VatRate[];

export function isVatRate(value: unknown): value is VatRate {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VAT_RATE_SET, value);
}

/** Stawka FaktWay → `P_12` FA(3) — te same pary co w generatorach (test je spina). */
export const FA3_P12_BY_VAT_RATE: Readonly<Record<VatRate, string>> = {
  '23': '23',
  '8': '8',
  '5': '5',
  '0': '0 KR',
  zw: 'zw',
  oo: 'oo',
  np: 'np I',
  np_ii: 'np II',
};

const VAT_RATE_BY_FA3_P12: ReadonlyMap<string, VatRate> = new Map(
  (Object.entries(FA3_P12_BY_VAT_RATE) as Array<[VatRate, string]>).map(([rate, p12]) => [p12, rate]),
);

/** Kody FA(3) bez odpowiednika w FaktWay — zapisywane dosłownie, JPK ich nie wykazuje. */
export const FA3_ONLY_VAT_RATES = ['0 WDT', '0 EX', '22', '7', '4', '3'] as const;
export type Fa3OnlyVatRate = (typeof FA3_ONLY_VAT_RATES)[number];

/** Pozycja bez P_12 (albo z kodem spoza FA(3)), której stawki nie da się ustalić jednoznacznie. */
export const UNKNOWN_VAT_RATE = 'nieznana';

export type ImportedVatRate = VatRate | Fa3OnlyVatRate | typeof UNKNOWN_VAT_RATE;

/** XSD `TZnakowy` to `xsd:token` — KSeF przyjmie „np  II”; porównujemy po zwinięciu białych znaków. */
function normalizeCode(raw: unknown): string {
  return raw == null ? '' : String(raw).replace(/\s+/g, ' ').trim();
}

/** `P_12` → stawka FaktWay (8 kodów bez straty informacji); `null` dla innych. */
export function domainVatRateFromFa3P12(p12: unknown): VatRate | null {
  return VAT_RATE_BY_FA3_P12.get(normalizeCode(p12)) ?? null;
}

/** Pola sum netto nagłówka FA(3) (`Fa/P_13_*`). */
export type Fa3NetField =
  | 'P_13_1' | 'P_13_2' | 'P_13_3' | 'P_13_4' | 'P_13_5'
  | 'P_13_6_1' | 'P_13_6_2' | 'P_13_6_3' | 'P_13_7' | 'P_13_8' | 'P_13_9' | 'P_13_10' | 'P_13_11';

export const FA3_NET_FIELDS: readonly Fa3NetField[] = [
  'P_13_1', 'P_13_2', 'P_13_3', 'P_13_4', 'P_13_5',
  'P_13_6_1', 'P_13_6_2', 'P_13_6_3', 'P_13_7', 'P_13_8', 'P_13_9', 'P_13_10', 'P_13_11',
];

/** Nagłówek faktury potrzebny do ustalenia stawki pozycji bez P_12. */
export interface Fa3RateHeader {
  nets: Partial<Record<Fa3NetField, number>>;
  /** Podatek dla P_13_1 i P_13_2 — rozróżnia 23/22 i 8/7. */
  vats: { P_14_1?: number; P_14_2?: number };
  /** `Adnotacje/Zwolnienie/P_19 = 1` — dostawa zwolniona. */
  exempt: boolean;
}

/** Stawka jednoznacznie wynikająca z pola sumy (bez proporcji podatku). */
const RATE_BY_NET_FIELD: Partial<Record<Fa3NetField, ImportedVatRate>> = {
  P_13_3: '5',
  P_13_6_1: '0',
  P_13_6_2: '0 WDT',
  P_13_6_3: '0 EX',
  P_13_7: 'zw',
  P_13_8: 'np',
  P_13_9: 'np_ii',
  P_13_10: 'oo',
};

const NONZERO = 0.005;

function nonZeroFields(header: Fa3RateHeader, among: readonly Fa3NetField[]): Fa3NetField[] {
  return among.filter((f) => Math.abs(header.nets[f] ?? 0) > NONZERO);
}

/** Stawka z proporcji podatku do netto (23 vs 22, 8 vs 7) — tylko gdy jednoznaczna. */
function rateFromRatio(net: number, vat: number | undefined, candidates: ReadonlyArray<[number, ImportedVatRate]>): ImportedVatRate | null {
  if (vat === undefined || Math.abs(net) <= NONZERO) return null;
  const ratio = vat / net;
  const hits = candidates.filter(([pct]) => Math.abs(ratio - pct) < 0.003);
  return hits.length === 1 ? hits[0]![1] : null;
}

function rateFromSingleBucket(header: Fa3RateHeader, among: readonly Fa3NetField[]): ImportedVatRate | null {
  const fields = nonZeroFields(header, among);
  if (fields.length !== 1) return null;
  const field = fields[0]!;
  if (field === 'P_13_1') return rateFromRatio(header.nets.P_13_1!, header.vats.P_14_1, [[0.23, '23'], [0.22, '22']]);
  if (field === 'P_13_2') return rateFromRatio(header.nets.P_13_2!, header.vats.P_14_2, [[0.08, '8'], [0.07, '7']]);
  return RATE_BY_NET_FIELD[field] ?? null;
}

/**
 * Stawka pozycji zaimportowanej z KSeF (do zapisu w `invoice_line_items.vat_rate`):
 *  - jeden z 8 kodów FaktWay → stawka FaktWay;
 *  - kod FA(3) bez odpowiednika → ten kod dosłownie;
 *  - gołe „0” / „np” (FA(2)) → wariant z jedynej niezerowej sumy rodziny
 *    (P_13_6_1/2/3, P_13_8/9);
 *  - brak P_12 → stawka z jedynej niezerowej sumy nagłówka (23/22 i 8/7
 *    po proporcji podatku); bez sum przy zwolnieniu (P_19 = 1) → „zw”;
 *    zwolnienie obok innej sumy → „nieznana” (pozycja może być zwolniona);
 *  - wszystko inne → „nieznana”.
 */
export function importVatRateFromFa3(p12: unknown, header: Fa3RateHeader): ImportedVatRate {
  const code = normalizeCode(p12);
  if (code) {
    const domain = domainVatRateFromFa3P12(code);
    if (domain) return domain;
    if ((FA3_ONLY_VAT_RATES as readonly string[]).includes(code)) return code as Fa3OnlyVatRate;
    if (code === '0') return rateFromSingleBucket(header, ['P_13_6_1', 'P_13_6_2', 'P_13_6_3']) ?? UNKNOWN_VAT_RATE;
    if (code.toLowerCase() === 'np') return rateFromSingleBucket(header, ['P_13_8', 'P_13_9']) ?? UNKNOWN_VAT_RATE;
    return UNKNOWN_VAT_RATE;
  }
  const buckets = nonZeroFields(header, FA3_NET_FIELDS);
  if (buckets.length === 0) return header.exempt ? 'zw' : UNKNOWN_VAT_RATE;
  // Zwolnienie (P_19 = 1) obok innej sumy: pozycja bez P_12 może być tą
  // zwolnioną, której suma P_13_7 nie musi występować — nie zgadujemy.
  if (header.exempt && buckets[0] !== 'P_13_7') return UNKNOWN_VAT_RATE;
  return rateFromSingleBucket(header, FA3_NET_FIELDS) ?? UNKNOWN_VAT_RATE;
}

const LABELS: Readonly<Record<string, string>> = {
  '0 WDT': 'wewnątrzwspólnotowa dostawa towarów, 0%',
  '0 EX': 'eksport towarów, 0%',
  '22': 'stawka 22% sprzed 2011 r.',
  '7': 'stawka 7% sprzed 2011 r.',
  '4': 'ryczałt dla taksówek osobowych, 4%',
  '3': 'ryczałt dla taksówek osobowych, 3%',
  [UNKNOWN_VAT_RATE]: 'pozycja bez stawki w KSeF, której nie da się ustalić z sum faktury',
};

/** Opis kodu bez odpowiednika w FaktWay (komunikaty i karta faktury); `null` dla stawek FaktWay. */
export function importedVatRateLabel(code: string): string | null {
  return LABELS[code] ?? null;
}
