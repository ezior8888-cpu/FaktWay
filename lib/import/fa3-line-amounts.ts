/**
 * C5c (plan „zero zgubionych faktur”, C5): kwoty pozycji faktury z importu
 * KSeF — netto, VAT i brutto zgodne z sumami nagłówka co do grosza.
 *
 * Podstawa: ustawa o VAT, art. 106e ust. 7–11 (Dz.U. 2026 poz. 1263).
 * - ust. 7: przy cenach brutto podatek liczy się od SUMY wartości brutto
 *   stawki: KP = WB × SP / (100 + SP); ust. 9: netto stawki = WB − KP;
 * - ust. 8: cena i wartość brutto (P_9B, P_11A) zamiast netto (P_9A, P_11);
 * - ust. 1 pkt 14: także przy cenach netto podatek jest od sumy netto stawki;
 * - ust. 10: VAT może być podany przy pozycji (P_11Vat), a suma — ich sumą;
 * - ust. 11: zaokrąglenie do grosza.
 * Prawdą jest więc nagłówek (P_13_x / P_14_x). VAT pozycji — z pliku, gdy go
 * podaje (P_11Vat albo P_11A − P_11), inaczej VAT nagłówka rozłożony metodą
 * największej reszty: każda pozycja dostaje swój udział zaokrąglony w dół
 * albo w górę, nic innego. Netto pozycji faktury brutto to NASZ podział, nie
 * dana z faktury — JPK_FA dostaje pola pozycji z pliku (`ksefLineFields`).
 *
 * Czego nie da się przenieść wiernie, zatrzymujemy z powodem (nigdy nie
 * zgadujemy VAT): pozycje tej stawki zostają jak dotąd, a JPK odmawia.
 * Moduł czysty; kwoty w groszach całkowitych (Number — bezpieczne do 2^53).
 */

import { roundToCents } from '@/lib/xml/invoice-calculator';
import type { ParsedInvoice, ParsedLine } from './fa3-parser';

export interface ImportLineRow {
  ordinal: number;
  /** Cena netto z pliku (P_9A); NULL, gdy plik jej nie podaje (ceny brutto, faktura uproszczona). */
  unitPriceNet: number | null;
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
}

/** Pola pozycji z pliku dla JPK_FA(4) FakturaWiersz (tylko obecne). */
export interface KsefLineFields {
  ordinal: number;
  P_8B?: number;
  P_9A?: number;
  P_9B?: number;
  P_10?: number;
  P_11?: number;
  P_11A?: number;
}

export interface ImportLineAmounts {
  rows: ImportLineRow[];
  /** Brak przy powtórzonych numerach pozycji albo pliku spoza KSeF. */
  ksefLineFields?: KsefLineFields[];
  problems: string[];
  /**
   * Netto i VAT faktury policzone z pozycji — tylko faktura bez sum stawek
   * (P_13_x / P_14_x), gdy pozycje zgadzają się z P_15. Inaczej sumy z nagłówka.
   */
  totals?: { netTotal: number; vatTotal: number };
  /** Netto i VAT faktury są nieznane (brak sum stawki albo pozycje ≠ P_15) — KPiR i CSV też ich nie pokażą. */
  totalsUnknown?: true;
}

// ── Odczyt ściśle jak XSD (żadnego cichego 0) ───────────────────────────────

/** TKwotowy (2 miejsca) → grosze całkowite; `null` = nieczytelne. */
function grosze(raw: string): number | null {
  const m = /^(-?)(\d{1,16})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] && value ? -value : value;
}

/** TKwotowy2 / TIlosci (do 8 miejsc) → liczba; `null` = nieczytelne. */
function decimal(raw: string): number | null {
  const s = raw.trim();
  return /^-?\d{1,16}(\.\d{1,8})?$/.test(s) ? Number(s) : null;
}

const zl = (g: number) => (g / 100).toFixed(2);

// ── Stawki → pola nagłówka ──────────────────────────────────────────────────

const VAT_BUCKETS: Readonly<Record<string, { net: string; vat: string; pct: number }>> = {
  '23': { net: 'P_13_1', vat: 'P_14_1', pct: 23 },
  '22': { net: 'P_13_1', vat: 'P_14_1', pct: 22 },
  '8': { net: 'P_13_2', vat: 'P_14_2', pct: 8 },
  '7': { net: 'P_13_2', vat: 'P_14_2', pct: 7 },
  '5': { net: 'P_13_3', vat: 'P_14_3', pct: 5 },
};
const NO_VAT_BUCKETS: Readonly<Record<string, string>> = {
  '0': 'P_13_6_1', '0 WDT': 'P_13_6_2', '0 EX': 'P_13_6_3',
  zw: 'P_13_7', np: 'P_13_8', np_ii: 'P_13_9', oo: 'P_13_10',
};
/**
 * Taryfa ryczałtowa taksówek — FaktWay jej nie rozkłada (odmowa stawki z C5a).
 * Sumy P_13_4 (taksówki), P_13_5 (OSS) i P_13_11 (marża) nie mają stawki
 * FaktWay — bez kontroli „suma bez pozycji” (odmowa stawki albo procedury).
 */
const NOT_DISTRIBUTED = new Set(['4', '3']);
const VAT_PAIRS: ReadonlyArray<readonly [string, string]> = [['P_13_1', 'P_14_1'], ['P_13_2', 'P_14_2'], ['P_13_3', 'P_14_3']];

/** Dotychczasowa reguła (sprzed C5c): VAT = netto × stawka pozycji. Dla plików spoza KSeF bez zmian. */
export function legacyLineAmounts(line: ParsedLine, unitPriceNet: number | null = line.unitPriceNet): ImportLineRow {
  const net = line.netAmount;
  const raw = line.vatRate.trim().toLowerCase();
  let vat = 0;
  if (!(raw === 'zw' || raw === 'oo' || raw === 'np' || /^0(\s|$|kr|ex|wt)/i.test(raw))) {
    const pctMatch = raw.match(/^(\d+(?:[.,]\d+)?)/);
    const pct = pctMatch ? parseFloat(pctMatch[1]!.replace(',', '.')) : NaN;
    if (Number.isFinite(pct)) vat = roundToCents((net * pct) / 100);
  }
  return { ordinal: line.position, unitPriceNet, netAmount: net, vatAmount: vat, grossAmount: roundToCents(net + vat) };
}

interface LineFacts {
  index: number;
  line: ParsedLine;
  rate: string;
  p11?: number;
  p11a?: number;
  p11vat?: number;
  unitPriceNet: number | null;
  unreadable: string[];
}

function factsOf(line: ParsedLine, index: number): LineFacts {
  const k = line.ksef ?? {};
  const unreadable: string[] = [];
  const money = (field: 'P_11' | 'P_11A' | 'P_11Vat') => {
    const raw = k[field];
    if (raw === undefined) return undefined;
    const g = grosze(raw);
    if (g === null) unreadable.push(`${field} „${raw}”`);
    return g ?? undefined;
  };
  let unitPriceNet: number | null = null;
  if (k.P_9A !== undefined) {
    unitPriceNet = decimal(k.P_9A);
    if (unitPriceNet === null) unreadable.push(`P_9A „${k.P_9A}”`);
  }
  return {
    index, line, rate: line.vatRate.trim(),
    p11: money('P_11'), p11a: money('P_11A'), p11vat: money('P_11Vat'),
    unitPriceNet, unreadable,
  };
}

function ksefLineFieldsOf(lines: readonly ParsedLine[]): KsefLineFields[] {
  return lines.map((line) => {
    const k = line.ksef ?? {};
    const out: KsefLineFields = { ordinal: line.position };
    for (const f of ['P_8B', 'P_9A', 'P_9B', 'P_10'] as const) {
      const v = k[f] === undefined ? null : decimal(k[f]!);
      if (v !== null) out[f] = v;
    }
    for (const f of ['P_11', 'P_11A'] as const) {
      const g = k[f] === undefined ? null : grosze(k[f]!);
      if (g !== null) out[f] = g / 100;
    }
    return out;
  });
}

/**
 * Rozkład VAT nagłówka `total` na pozycje: udział = podstawa × stawka / mianownik
 * (brutto: 100 + stawka, netto: 100), w dół; brakujące grosze do największych
 * reszt (porównanie na krzyż — różne mianowniki przy 23% i 22%), remis — niższy
 * numer pozycji, potem kolejność w pliku. `null`, gdy `total` poza [Σ w dół, Σ w górę].
 */
function allocate(
  shares: ReadonlyArray<{ num: number; den: number; ordinal: number; index: number }>,
  total: number,
): { vats: number[]; floor: number; ceil: number } | { vats: null; floor: number; ceil: number } {
  const parts = shares.map((s) => {
    const fl = Math.floor(s.num / s.den);
    return { ...s, fl, rem: s.num - fl * s.den };
  });
  const floor = parts.reduce((a, p) => a + p.fl, 0);
  const ceil = parts.reduce((a, p) => a + p.fl + (p.rem > 0 ? 1 : 0), 0);
  if (total < floor || total > ceil) return { vats: null, floor, ceil };
  const order = parts
    .map((p, i) => ({ ...p, i }))
    .filter((p) => p.rem > 0)
    .sort((a, b) => (b.rem * a.den - a.rem * b.den) || (a.ordinal - b.ordinal) || (a.index - b.index));
  const vats = parts.map((p) => p.fl);
  for (const p of order.slice(0, total - floor)) vats[p.i]! += 1;
  return { vats, floor, ceil };
}

/** Zaokrąglenie ilorazu do grosza (ust. 11: od 0,5 grosza w górę), symetrycznie dla kwot ujemnych. */
function roundDiv(num: number, den: number): number {
  const value = Math.floor((2 * Math.abs(num) + den) / (2 * den));
  return num < 0 ? -value : value;
}

/** VAT podany przy pozycji (ust. 10): P_11Vat albo P_11A − P_11. */
const fixedVat = (f: LineFacts) => f.p11vat ?? (f.p11 !== undefined && f.p11a !== undefined ? f.p11a - f.p11 : undefined);

interface Derived {
  f: LineFacts;
  net: number;
  vat: number;
  gross: number;
}

/**
 * Netto, VAT i brutto pozycji jednej grupy stawki. `target` — sumy nagłówka
 * (brak sumy = 0). Bez `target.vat` (faktura bez sum stawek; grupa = jedna
 * stawka) VAT liczymy od sumy wartości stawki: ust. 7 przy cenach brutto,
 * ust. 1 pkt 14 przy netto. `null`, gdy nie da się wiernie — powód w `fail`.
 */
function splitBucket(
  bucket: readonly LineFacts[],
  target: { net?: number; vat?: number },
  fail: (text: string) => void,
): Derived[] | null {
  const hasN = bucket.some((f) => f.p11 !== undefined && f.p11a === undefined);
  const hasG = bucket.some((f) => f.p11a !== undefined && f.p11 === undefined);
  const fixedCount = bucket.filter((f) => fixedVat(f) !== undefined).length;
  if (hasN && hasG) { fail('pozycje z wartością netto (P_11) i brutto (P_11A) naraz'); return null; }
  if (fixedCount > 0 && fixedCount < bucket.length) { fail('VAT pozycji (P_11Vat albo P_11 i P_11A) tylko przy części pozycji'); return null; }
  if (target.net !== undefined && target.vat !== undefined && bucket.every((f) => f.p11a !== undefined)) {
    const gross = bucket.reduce((a, f) => a + f.p11a!, 0);
    if (gross !== target.net + target.vat) {
      fail(`brutto pozycji ${zl(gross)} ≠ netto ${zl(target.net)} + VAT ${zl(target.vat)} z nagłówka`);
      return null;
    }
  }
  let vats: number[];
  if (fixedCount === bucket.length) {
    vats = bucket.map((f) => fixedVat(f)!);
    const sum = vats.reduce((a, v) => a + v, 0);
    if (target.vat !== undefined && sum !== target.vat) { fail(`VAT pozycji ${zl(sum)} ≠ VAT z nagłówka ${zl(target.vat)}`); return null; }
  } else {
    const shares = bucket.map((f) => {
      const pct = VAT_BUCKETS[f.rate]!.pct;
      return f.p11 !== undefined
        ? { num: f.p11 * pct, den: 100, ordinal: f.line.position, index: f.index }
        : { num: f.p11a! * pct, den: 100 + pct, ordinal: f.line.position, index: f.index };
    });
    // Bez sumy nagłówka grupa ma jedną stawkę i jeden rodzaj wartości — wspólny mianownik.
    const total = target.vat ?? roundDiv(shares.reduce((a, s) => a + s.num, 0), shares[0]!.den);
    const result = allocate(shares, total);
    if (!result.vats) {
      fail(`VAT z nagłówka ${zl(total)} nie wynika z wartości pozycji (możliwe ${zl(result.floor)}–${zl(result.ceil)})`);
      return null;
    }
    vats = result.vats;
  }
  const derived = bucket.map((f, i) => {
    const vat = vats[i]!;
    const net = f.p11 ?? f.p11a! - vat;
    return { f, net, vat, gross: f.p11a ?? net + vat };
  });
  if (target.net !== undefined) {
    const net = derived.reduce((a, d) => a + d.net, 0);
    if (net !== target.net) { fail(`netto pozycji ${zl(net)} ≠ netto z nagłówka ${zl(target.net)}`); return null; }
  }
  return derived;
}

const sumOf = (ds: readonly Derived[], key: 'net' | 'vat' | 'gross') => ds.reduce((a, d) => a + d[key], 0);

/**
 * Kwoty pozycji faktury z importu KSeF. Plik spoza KSeF (JPK, CSV), korekta,
 * zaliczka i ROZ (odmowa z rodzaju, C5a) albo stawka nieznana — jak dotąd.
 */
export function fa3ImportLineAmounts(inv: ParsedInvoice): ImportLineAmounts {
  const lines = inv.lines;
  const sums = inv.ksefSums;
  if (!sums || !lines.every((l) => l.ksef) || inv.invoiceType !== 'regular') {
    return { rows: lines.map((l) => legacyLineAmounts(l)), problems: [] };
  }

  const facts = lines.map(factsOf);
  const problems: string[] = [];
  let totalsUnknown = false;
  let totals: { netTotal: number; vatTotal: number } | undefined;
  const rows: ImportLineRow[] = facts.map((f) => legacyLineAmounts(f.line, f.unitPriceNet));
  const write = (ds: readonly Derived[]) => {
    for (const d of ds) {
      rows[d.f.index] = { ordinal: d.f.line.position, unitPriceNet: d.f.unitPriceNet, netAmount: d.net / 100, vatAmount: d.vat / 100, grossAmount: d.gross / 100 };
    }
  };

  const ordinals = lines.map((l) => l.position);
  const duplicated = [...new Set(ordinals.filter((o, i) => ordinals.indexOf(o) !== i))];

  // Stawka nieznana: przynależność do sum niepewna — nic nie rozkładamy (odmowa stawki, C5a).
  const unknownRate = facts.some((f) => !(f.rate in VAT_BUCKETS) && !(f.rate in NO_VAT_BUCKETS) && !NOT_DISTRIBUTED.has(f.rate));
  if (unknownRate) {
    return { rows, ...(duplicated.length ? {} : { ksefLineFields: ksefLineFieldsOf(lines) }), problems: [] };
  }

  for (const f of facts) {
    if (f.unreadable.length) problems.push(`pozycja ${f.line.position}: ${f.unreadable.join(', ')} nieczytelne`);
    if (f.p11 === undefined && f.p11a === undefined && !f.unreadable.length) {
      problems.push(`pozycja ${f.line.position}: brak wartości (ani P_11, ani P_11A)`);
    }
    if (f.p11vat !== undefined && f.p11 !== undefined && f.p11a !== undefined && f.p11vat !== f.p11a - f.p11) {
      problems.push(`pozycja ${f.line.position}: P_11A − P_11 = ${zl(f.p11a - f.p11)} ≠ P_11Vat ${zl(f.p11vat)}`);
    }
  }
  if (duplicated.length && facts.some((f) => f.p11 === undefined || f.p11a !== undefined)) {
    problems.push(`numery pozycji (NrWierszaFa) powtarzają się: ${duplicated.join(', ')}`);
  }
  const badLine = (f: LineFacts) =>
    f.unreadable.length > 0 || (f.p11 === undefined && f.p11a === undefined) ||
    (f.p11vat !== undefined && f.p11 !== undefined && f.p11a !== undefined && f.p11vat !== f.p11a - f.p11);

  const header = (field: string): number | undefined | null => {
    const raw = sums[field];
    if (raw === undefined) return undefined;
    const g = grosze(raw);
    if (g === null) problems.push(`nagłówek: ${field} „${raw}” nieczytelne`);
    return g;
  };
  /** Stawka bez podatku: VAT pozycji musi być 0; netto = brutto = wartość pozycji. */
  const noVatDerived = (bucket: readonly LineFacts[]): Derived[] | null => {
    const wrong = bucket.find((f) => (f.p11vat ?? 0) !== 0 || (f.p11 !== undefined && f.p11a !== undefined && f.p11 !== f.p11a));
    if (wrong) {
      problems.push(`pozycja ${wrong.line.position}: stawka ${wrong.rate} bez podatku, a VAT ${zl(wrong.p11vat ?? (wrong.p11a! - wrong.p11!))}`);
      return null;
    }
    return bucket.map((f) => ({ f, net: f.p11 ?? f.p11a!, vat: 0, gross: f.p11 ?? f.p11a! }));
  };
  const labelOf = (bucket: readonly LineFacts[]) => [...new Set(bucket.map((f) => f.rate))].join('/');
  const grossAtUndistributed = facts.filter((f) => NOT_DISTRIBUTED.has(f.rate) && f.p11a !== undefined && f.p11 === undefined);

  if (Object.keys(sums).some((k) => k.startsWith('P_13_') || k.startsWith('P_14_'))) {
    // ── Sumy stawek w nagłówku: prawdą są P_13_x / P_14_x; brak sumy stawki = 0 ──
    for (const [netField, vatField] of VAT_PAIRS) {
      const bucket = facts.filter((f) => VAT_BUCKETS[f.rate]?.net === netField);
      const tn = header(netField);
      const tv = header(vatField);
      if (!bucket.length) {
        if ((tn ?? 0) !== 0 || (tv ?? 0) !== 0) problems.push(`suma ${netField} bez pozycji tej stawki (${zl(tn ?? 0)})`);
        continue;
      }
      if (bucket.some(badLine) || tn === null || tv === null) continue;
      const fail = (text: string) => { problems.push(`stawka ${labelOf(bucket)}: ${text}`); };
      const base = bucket.reduce((a, f) => a + (f.p11 ?? f.p11a!), 0);
      if (tn === undefined && tv === undefined && base !== 0) {
        fail(`brak sum ${netField}/${vatField} w nagłówku, a pozycje mają ${zl(base)}`);
        totalsUnknown = true;
        continue;
      }
      const derived = splitBucket(bucket, { net: tn ?? 0, vat: tv ?? 0 }, fail);
      if (derived) write(derived);
    }
    for (const field of new Set(Object.values(NO_VAT_BUCKETS))) {
      const bucket = facts.filter((f) => NO_VAT_BUCKETS[f.rate] === field);
      const t = header(field);
      if (!bucket.length) {
        if ((t ?? 0) !== 0) problems.push(`suma ${field} bez pozycji tej stawki (${zl(t ?? 0)})`);
        continue;
      }
      if (bucket.some(badLine) || t === null) continue;
      const derived = noVatDerived(bucket);
      if (!derived) continue;
      const net = sumOf(derived, 'net');
      if (t === undefined && net !== 0) {
        problems.push(`stawka ${labelOf(bucket)}: brak sumy ${field} w nagłówku, a pozycje mają ${zl(net)}`);
        totalsUnknown = true;
        continue;
      }
      if (net !== (t ?? 0)) {
        problems.push(`stawka ${labelOf(bucket)}: netto pozycji ${zl(net)} ≠ netto z nagłówka ${zl(t ?? 0)}`);
        continue;
      }
      write(derived);
    }
  } else {
    // ── Bez sum stawek (faktura uproszczona): kwoty z pozycji, VAT od sumy każdej
    // stawki, całość sprawdzona z P_15. Netto i VAT faktury tylko stąd — parser
    // nie ma ich skąd wziąć (przy cenach brutto dałby netto 0).
    let unknown = facts.some(badLine) || grossAtUndistributed.length > 0;
    const groups = new Map<string, LineFacts[]>();
    for (const f of facts) {
      if (f.rate in VAT_BUCKETS) groups.set(f.rate, [...(groups.get(f.rate) ?? []), f]);
    }
    const results = new Map<string, Derived[]>();
    for (const [rate, bucket] of groups) {
      if (bucket.some(badLine)) continue;
      const derived = splitBucket(bucket, {}, (text) => { problems.push(`stawka ${rate}: ${text}`); });
      if (derived) results.set(rate, derived);
      else unknown = true;
    }
    const noVat: Derived[] = [];
    for (const f of facts) {
      if (!(f.rate in NO_VAT_BUCKETS) || badLine(f)) continue;
      const derived = noVatDerived([f]);
      if (derived) noVat.push(...derived);
      else unknown = true;
    }
    // Taksówki (4%/3%) bez rozkładu: kwoty faktury zostają z parsera, jak dotąd.
    const undistributed = facts.some((f) => NOT_DISTRIBUTED.has(f.rate));
    if (!unknown && !undistributed) {
      const p15 = header('P_15');
      if (p15 === undefined) problems.push('nagłówek: brak P_15');
      if (p15 === undefined || p15 === null) {
        unknown = true;
      } else {
        const grossAll = () => sumOf([...[...results.values()].flat(), ...noVat], 'gross');
        // Wystawca liczył VAT inaczej niż od sumy (np. sumą VAT pozycji): przy jednej
        // stawce netto bez VAT pozycji VAT wynika z P_15 — o ile mieści się w podziale.
        const adjustable = [...results].filter(([, ds]) => ds.every((d) => d.f.p11a === undefined && fixedVat(d.f) === undefined));
        if (grossAll() !== p15 && adjustable.length === 1) {
          const [rate, ds] = adjustable[0]!;
          const vat = p15 - (grossAll() - sumOf(ds, 'gross')) - sumOf(ds, 'net');
          const adjusted = splitBucket(groups.get(rate)!, { vat }, () => {});
          if (adjusted) results.set(rate, adjusted);
        }
        const gross = grossAll();
        if (gross !== p15) {
          problems.push(`brutto pozycji ${zl(gross)} ≠ P_15 ${zl(p15)}`);
          unknown = true;
        }
      }
    }
    for (const ds of results.values()) write(ds);
    write(noVat);
    if (unknown) {
      totalsUnknown = true;
    } else if (!undistributed) {
      const all = [...[...results.values()].flat(), ...noVat];
      totals = { netTotal: sumOf(all, 'net') / 100, vatTotal: sumOf(all, 'vat') / 100 };
    }
  }

  // ── Stawki, których FaktWay nie rozkłada ──
  for (const f of grossAtUndistributed) {
    problems.push(`pozycja ${f.line.position}: ceny brutto przy stawce ${f.rate}, której FaktWay nie rozkłada`);
  }
  return {
    rows,
    ...(duplicated.length ? {} : { ksefLineFields: ksefLineFieldsOf(lines) }),
    problems: [...new Set(problems)],
    ...(totals ? { totals } : {}),
    ...(totalsUnknown ? { totalsUnknown: true as const } : {}),
  };
}
