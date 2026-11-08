/**
 * Brama pochodzenia oryginału z oznaczeniem FaktWay (D-A4-1b-3 PR C, plan
 * „zero zgubionych faktur”, spec v3 5.2; decyzje Bartosza 08.10.2026 C1–C8).
 *
 * Przy werdykcie `faktflow-original` runner ocenia plik oryginału z KSeF:
 * czy wygląda na plik z generatora FaktWay zwykłej faktury (`importable` —
 * klient zapisze go w FaktWay sam), czy nie (`review` — przegląd operatora,
 * I5R). Wynik trafia na znacznik jako `original_check.importGate`; SQL z 00156
 * czyta go w ofercie (`ksef_duplicate_original_offer`) i w blokadzie.
 *
 * Reguły są jawne (T2): każda odpowiada temu, czego generator FaktWay
 * zwykłej faktury nie pisze; `parsed.warnings` NIE jest używane. Reguły
 * 1 (`currency`) i 2 (`parse`) kończą ocenę, pozostałe zbierane naraz,
 * w kolejności `ORIGINAL_GATE_PROBLEMS`. `preview` liczony, gdy plik się
 * odczytał (reguła 2 przeszła).
 *
 * `importable` ma znaczyć „lustro 4.8 przejdzie” (commit 3, fix 4): inaczej
 * klient dostaje „nie do zapisania”, a cron znowu ocenia ten sam plik jako
 * `importable` — pętla bez wyjścia operatora. Dlatego reguły 5 (`number`)
 * i 6 (`seller`) nie przepuszczają pustych stron, reguła 7 (`buyer-id`)
 * wymaga 10 cyfr obecnego NIP nabywcy, a reguła 10 (`line-fields`) pilnuje
 * długości nazwy (1–512) i jednostki (1–50) pozycji w punktach kodowych
 * (`char_length`), czyli granic 4.8 (`ORIGINAL_IMPORT_LIMITS`).
 *
 * CZYSTY moduł: bez bazy, magazynu, KSeF i zegara; nigdy nie rzuca (każdy
 * wyjątek → `parse`). Te same bajty i ta sama wersja reguł → ta sama brama
 * (ponowienie runnera od zera nadpisuje znacznik tym samym wynikiem).
 */

import type { ImportContent } from '@/lib/import/fa3-content';
import type { ImportLineAmounts } from '@/lib/import/fa3-line-amounts';
import { parseFa3Xml, type ParsedInvoice, type ParsedParty } from '@/lib/import/fa3-parser';
import { importedInvoiceContent } from '@/lib/import/imported-invoice-row';
import { exemptionMismatch } from '@/lib/xml/fa3-annotations';
import { FA3_P12_BY_VAT_RATE } from '@/lib/xml/fa3-p12';

import {
  ORIGINAL_GATE_PROBLEMS,
  ORIGINAL_GATE_RULES,
  type KsefOriginalImportGate,
  type OriginalBuyerIdKind,
  type OriginalGateProblem,
  type OriginalPreview,
  type OriginalPreviewAnnotation,
} from './duplicate-check';
import { ORIGINAL_IMPORT_LIMITS } from './duplicate-original-projection';
import { summarizeInvoiceXml } from './duplicate-verdict';

export interface OriginalGateInput {
  /** Plik oryginału (`decodeKsefXml(originalBytes)`). */
  xml: string;
  /** K — numer KSeF oryginału. */
  ksefNumber: string;
  /** Numer naszego dokumentu X (`invoice.internalNumber ?? ''`) — reguła 5 `number`. */
  internalNumber: string;
  /** NIP firmy (10 cyfr) — reguła 6 `seller`. */
  tenantNip: string;
}

export interface OriginalGateEvaluation {
  gate: KsefOriginalImportGate;
  /** `null`, gdy plik nie dał się odczytać (`parse`) albo waluta ≠ PLN (`currency`). */
  parsed: ParsedInvoice | null;
  content: ImportContent | null;
  amounts: ImportLineAmounts | null;
}

/** Podgląd pokazuje najwyżej tyle pozycji (`OriginalPreview.lines`). */
const PREVIEW_MAX_LINES = 20;
/** Nazwa pozycji w podglądzie ma najwyżej tyle znaków (z wielokropkiem, gdy skrócona). */
const PREVIEW_NAME_MAX = 120;
/** NIP nabywcy: dokładnie tyle cyfr (reguła 7 `buyer-id`, `buyerIdentityFromParsed`). */
const BUYER_NIP_DIGITS = 10;

/** Wartości `P_12`, które pisze generator FaktWay (`VAT_RATE_MAP`) — reguła 11 `rates`. */
const GENERATOR_P12: ReadonlySet<string> = new Set(Object.values(FA3_P12_BY_VAT_RATE));

const present = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';
const digitsOf = (value: string | undefined): string => (value ?? '').replace(/\D/g, '');

/** `char_length` jak w 4.8: znaki Unicode (punkty kodowe), nie jednostki UTF-16. */
const withinCodePoints = (text: string, min: number, max: number): boolean => {
  const length = Array.from(text).length;
  return length >= min && length <= max;
};

/** Rodzaj identyfikatora nabywcy: `nip` → `vat-ue` → `pesel` → `nr-inny` → `brak-id` → `none`. */
function buyerIdKindOf(buyer: ParsedParty): OriginalBuyerIdKind {
  if (present(buyer.nip)) return 'nip';
  if (present(buyer.vatUeNumber)) return 'vat-ue';
  if (present(buyer.pesel)) return 'pesel';
  if (present(buyer.nrInny)) return 'nr-inny';
  if (buyer.brakId) return 'brak-id';
  return 'none';
}

/** Kwota z pliku (TKwotowy, najwyżej 2 miejsca) w groszach całkowitych; `null` = nieczytelna. */
function centsOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^(-?)(\d{1,16})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] && value ? -value : value;
}

/**
 * Reguła 13: brak P_15 (albo nieczytelne sumy) albo P_15 ≠ Σ P_13_x + Σ P_14_x co do grosza.
 * Ściśle (nie ±0,01 jak w spec 5.2): kontrola zapisu 4.8 `totals` wymaga równości, a plik
 * „importable”, którego nie da się zapisać, krążyłby w ponownym sprawdzeniu bez wyjścia.
 * Generator FaktWay sumuje P_15 dokładnie, więc każda różnica = plik do przeglądu.
 */
function totalsDoNotAddUp(sums: ParsedInvoice['ksefSums']): boolean {
  if (!sums) return true;
  const gross = centsOf(sums.P_15);
  if (gross === null) return true;
  let parts = 0;
  for (const [field, raw] of Object.entries(sums)) {
    if (!/^P_1[34]_/.test(field)) continue;
    const cents = centsOf(raw);
    if (cents === null) return true;
    parts += cents;
  }
  return gross !== parts;
}

/** Reguła 14: adnotacje, których generator FaktWay zwykłej faktury nie pisze, albo niespójne ze stawkami pozycji. */
function annotationsBreakRules(parsed: ParsedInvoice, content: ImportContent): boolean {
  if (content.annotationProblems.length > 0) return true;
  const file = parsed.ksefAnnotations;
  if (file?.p17 === 1 || file?.p23 === 1 || file?.newMeansOfTransport === true || file?.marginScheme) return true;
  const rates = parsed.lines.map((line) => line.vatRate);
  // P_18 = 1 dokładnie wtedy, gdy któraś pozycja ma stawkę oo albo np II (`buildInvoiceAnnotations`).
  const reverseChargeLine = rates.some((rate) => rate === 'oo' || rate === 'np_ii');
  if ((file?.p18 === 1) !== reverseChargeLine) return true;
  return exemptionMismatch(content.annotations, rates);
}

/** Reguła 15: FP, TP, RolaPU, GTU albo Procedura — generator zwykłej faktury ich nie pisze. */
function hasMarkers(content: ImportContent): boolean {
  const markers = content.markers;
  if (!markers) return false;
  return Boolean(
    markers.fp ||
      markers.tp ||
      markers.authorizedEntityRole !== undefined ||
      markers.gtu?.length ||
      markers.procedures?.length,
  );
}

/** Reguła 16: data sprzedaży nieczytelna, `OkresFa` albo `P_6A` w którejś pozycji. */
function saleDateBreaksRules(parsed: ParsedInvoice): boolean {
  return (
    Boolean(parsed.saleDateProblems?.length) ||
    parsed.salePeriod !== undefined ||
    parsed.lines.some((line) => line.saleDate !== undefined)
  );
}

/**
 * Reguły 3–16 (1 i 2 kończą ocenę wcześniej). Zwracane w kolejności
 * `ORIGINAL_GATE_PROBLEMS`, bez powtórzeń — niezależnie od kolejności sprawdzeń.
 */
function collectProblems(
  input: OriginalGateInput,
  parsed: ParsedInvoice,
  content: ImportContent,
  amounts: ImportLineAmounts,
): OriginalGateProblem[] {
  const found = new Set<OriginalGateProblem>();
  const lineKsef = parsed.lines.map((line) => line.ksef ?? {});

  if (parsed.formCode !== 'FA (3)') found.add('form');
  if (parsed.invoiceTypeCode !== 'VAT') found.add('kind');
  // Reguły 5 i 6 zawodzą zamknięte: strona pusta nie jest zgodna z pustą (4.8 odmówi `shape` — numer 1–100 znaków, NIP 10 cyfr).
  const fileNumber = parsed.invoiceNumber.trim();
  const ourNumber = input.internalNumber.trim();
  if (fileNumber === '' || ourNumber === '' || fileNumber !== ourNumber) found.add('number');
  const fileSellerNip = digitsOf(parsed.seller.nip);
  const tenantNip = digitsOf(input.tenantNip);
  if (fileSellerNip === '' || tenantNip === '' || fileSellerNip !== tenantNip) found.add('seller');
  // Obecny NIP nabywcy ma 10 cyfr (po odfiltrowaniu nie-cyfr, jak `buyerIdentityFromParsed`): przy innej liczbie
  // projekcja nie niesie `buyer_nip`, a plik tak, i 4.8 odmawia `buyer`.
  if (
    buyerIdKindOf(parsed.buyer) === 'none' ||
    (present(parsed.buyer.nip) && digitsOf(parsed.buyer.nip).length !== BUYER_NIP_DIGITS)
  ) {
    found.add('buyer-id');
  }
  if (parsed.lines.length === 0) found.add('no-lines');
  if (lineKsef.some((k) => k.P_9B !== undefined || k.P_11A !== undefined)) found.add('gross-prices');
  if (
    parsed.lines.some(
      (line, i) =>
        lineKsef[i]!.P_9A === undefined ||
        lineKsef[i]!.P_11 === undefined ||
        line.p12 === undefined ||
        lineKsef[i]!.P_10 !== undefined ||
        lineKsef[i]!.P_11Vat !== undefined ||
        !withinCodePoints(line.name, 1, ORIGINAL_IMPORT_LIMITS.lineNameMax) ||
        !withinCodePoints(line.unit, 1, ORIGINAL_IMPORT_LIMITS.lineUnitMax),
    )
  ) {
    found.add('line-fields');
  }
  // Brak P_12 daje wyłącznie `line-fields`: stawki liczą się tylko przy OBECNYM P_12.
  if (parsed.lines.some((line) => line.p12 !== undefined && !GENERATOR_P12.has(line.p12))) found.add('rates');
  if (amounts.problems.length > 0 || amounts.totalsUnknown) found.add('amounts');
  if (totalsDoNotAddUp(parsed.ksefSums)) found.add('totals');
  if (annotationsBreakRules(parsed, content)) found.add('annotations');
  if (hasMarkers(content)) found.add('markers');
  if (saleDateBreaksRules(parsed)) found.add('sale-date');

  return ORIGINAL_GATE_PROBLEMS.filter((problem) => found.has(problem));
}

/** Nazwa pozycji do podglądu: najwyżej 120 znaków, początek zachowany (bez przecięcia pary zastępczej). */
function previewName(name: string): string {
  if (name.length <= PREVIEW_NAME_MAX) return name;
  let cut = name.slice(0, PREVIEW_NAME_MAX - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const money = (value: number): string => (Number.isFinite(value) ? value : 0).toFixed(2);

/** Okres MM.RRRR z P_1 (RRRR-MM-DD); gdy P_1 jest nieczytelne — pusty napis (odmówi lustro 4.8, `issue-date`). */
function periodOf(issueDate: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(issueDate);
  return m ? `${m[2]}.${m[1]}` : '';
}

function previewAnnotations(content: ImportContent): OriginalPreviewAnnotation[] {
  const a = content.annotations;
  const out: OriginalPreviewAnnotation[] = [];
  if (a?.cashMethod === 1) out.push('cashMethod');
  if (a?.splitPayment === 1) out.push('splitPayment');
  if (a?.reverseCharge === 1) out.push('reverseCharge');
  if (a?.vatExemptionBasis?.trim()) out.push('exemption');
  return out;
}

/**
 * Podgląd oryginału na znaczniku (strona klienta nie czyta archiwum, INV-13).
 * Ilość i cena netto — tekst z pliku; brutto pozycji i sumy — kwoty, z których
 * powstanie zapisana faktura (te same co w `buildImportedInvoiceRow`).
 */
function buildPreview(parsed: ParsedInvoice, content: ImportContent, amounts: ImportLineAmounts): OriginalPreview {
  const lines = parsed.lines.slice(0, PREVIEW_MAX_LINES).map((line, i) => ({
    ordinal: line.position,
    name: previewName(line.name),
    quantity: line.ksef?.P_8B ?? String(line.quantity),
    unit: line.unit,
    unitPriceNet: line.ksef?.P_9A ?? null,
    vatRate: line.vatRate,
    gross: money(amounts.rows[i]?.grossAmount ?? 0),
  }));
  return {
    issueDate: parsed.issueDate,
    saleDate: content.saleDate,
    period: periodOf(parsed.issueDate),
    buyerIdKind: buyerIdKindOf(parsed.buyer),
    annotations: previewAnnotations(content),
    exemptionBasis: content.annotations?.vatExemptionBasis ?? null,
    lineCount: parsed.lines.length,
    lines,
    totals: {
      net: money(amounts.totals?.netTotal ?? parsed.totals.netTotal),
      vat: money(amounts.totals?.vatTotal ?? parsed.totals.vatTotal),
      gross: money(parsed.totals.grossTotal),
    },
  };
}

/** Ocena zakończona na regule 1 albo 2: plik nieodczytany — bez podglądu, bez treści i kwot. */
function unreadable(problem: 'currency' | 'parse'): OriginalGateEvaluation {
  return {
    gate: { v: 1, rules: ORIGINAL_GATE_RULES, kind: 'review', problems: [problem], preview: null },
    parsed: null,
    content: null,
    amounts: null,
  };
}

function evaluate(input: OriginalGateInput): OriginalGateEvaluation {
  // Reguła 1 (`currency`): odczyt waluty jak `summarizeInvoiceXml`, PRZED parserem — parser odmawia waluty obcej
  // wyjątkiem, a tu ma to być osobny, nazwany problem. Brak albo pusty `KodWaluty` nie jest problemem.
  const currency = summarizeInvoiceXml(input.xml).currency?.trim().toUpperCase() ?? '';
  if (currency !== '' && currency !== 'PLN') return unreadable('currency');

  // Reguła 2 (`parse`): wyjątek parsera; wyjątek w dalszych krokach łapie `evaluateOriginalGate`.
  const parsed = parseFa3Xml(input.xml, { ksefNumber: input.ksefNumber });
  const { content, amounts } = importedInvoiceContent(parsed);

  const problems = collectProblems(input, parsed, content, amounts);
  return {
    gate: {
      v: 1,
      rules: ORIGINAL_GATE_RULES,
      kind: problems.length === 0 ? 'importable' : 'review',
      problems,
      preview: buildPreview(parsed, content, amounts),
    },
    parsed,
    content,
    amounts,
  };
}

/**
 * Ocena pliku oryginału (reguły 5.2). Czysta, deterministyczna, nigdy nie rzuca:
 * każdy wyjątek (parser, treść, kwoty pozycji, podgląd) to problem `parse`.
 */
export function evaluateOriginalGate(input: OriginalGateInput): OriginalGateEvaluation {
  try {
    return evaluate(input);
  } catch {
    return unreadable('parse');
  }
}
