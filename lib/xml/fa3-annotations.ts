/**
 * C5b (plan „zero zgubionych faktur”, C5): odczyt z pliku FA(3)/FA(2) tego,
 * co import historii KSeF dotąd gubił — data sprzedaży (TDataT) i Adnotacje
 * (P_16…P_23, zwolnienie, nowe środki transportu, marża) oraz oznaczenia,
 * których JPK FaktWay nie wykazuje (FP, TP, podmiot upoważniony, GTU,
 * procedury w pozycjach).
 *
 * Wartości przychodzą jako tekst (`parseTagValue: false` w parserze), a
 * FaktWay trzyma flagi jako liczby 1|2 (`InvoiceAnnotations`). Niczego
 * nieczytelnego nie zamieniamy na „nie” (2) — trafia do problemów, a JPK
 * odmawia z numerem faktury. Moduł czysty: bez bazy i bez Node.
 */

import type { JpkInvoiceAnnotations } from '@/lib/exports/jpk-fa-generator';
import { isVatRate } from '@/lib/xml/fa3-p12';
import type { InvoiceAnnotations } from '@/types/invoice';

export const MARGIN_SCHEMES = ['P_PMarzy_2', 'P_PMarzy_3_1', 'P_PMarzy_3_2', 'P_PMarzy_3_3'] as const;
export type MarginScheme = (typeof MARGIN_SCHEMES)[number];
export const EXEMPTION_BASIS_KINDS = ['P_19A', 'P_19B', 'P_19C'] as const;
export type ExemptionBasisKind = (typeof EXEMPTION_BASIS_KINDS)[number];

/** Adnotacje tak, jak mówi plik. Brak klucza = nie udało się odczytać (problem). */
export interface Fa3Annotations {
  p16?: 1 | 2;
  p17?: 1 | 2;
  p18?: 1 | 2;
  p18a?: 1 | 2;
  p23?: 1 | 2;
  /** `null` = P_19N (bez zwolnienia). */
  exemption?: { kind: ExemptionBasisKind; basis: string } | null;
  /** P_22 = 1. Szczegóły (P_42_5, NowySrodekTransportu) zostają w archiwum XML. */
  newMeansOfTransport?: boolean;
  /** `null` = P_PMarzyN (bez procedury marży). */
  marginScheme?: MarginScheme | null;
}

/** Oznaczenia spoza Adnotacji, których JPK FaktWay nie wykazuje (zatrzymanie w JPK). */
export interface Fa3Markers {
  /** FP — faktura do paragonu (art. 109 ust. 3d). */
  fp?: true;
  /** TP — powiązania między nabywcą a dostawcą. */
  tp?: true;
  /** RolaPU podmiotu upoważnionego (1 organ egzekucyjny, 2 komornik, 3 przedstawiciel podatkowy). */
  authorizedEntityRole?: string;
  /** Oznaczenia GTU z pozycji (unikalne). */
  gtu?: string[];
  /** Procedury z pozycji (WSTO_EE, IED, TT_D, I_42…). */
  procedures?: string[];
}

type XmlNode = Record<string, unknown>;

const isNode = (v: unknown): v is XmlNode => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Wartość proste (tekst lub liczba) — element powtórzony albo złożony to `null`. */
function scalar(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

/** TWybor1_2 (xsd:byte, 1 = tak, 2 = nie). Leksyka xsd:byte dopuszcza „01” i „+1”. */
export function readTWybor1_2(raw: unknown): 1 | 2 | null {
  const s = scalar(raw);
  if (s === null) return null;
  const m = /^\+?0*([12])$/.exec(s.replace(/\s+/g, ''));
  return m ? (Number(m[1]) as 1 | 2) : null;
}

/** TWybor1 (tylko „1”): obecne i poprawne, nieobecne albo błędne. */
function readTWybor1(raw: unknown): 'yes' | 'absent' | 'invalid' {
  if (raw === undefined || raw === null) return 'absent';
  const s = scalar(raw);
  return s !== null && /^\+?0*1$/.test(s.replace(/\s+/g, '')) ? 'yes' : 'invalid';
}

/** TDataT FA(3): RRRR-MM-DD bez strefy (etd:TData), prawdziwa data, 2006-01-01..2050-01-01. */
export function readTDataT(raw: unknown): string | null {
  const s = scalar(raw)?.trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return s >= '2006-01-01' && s <= '2050-01-01' ? s : null;
}

/** Tekst do komunikatu: „tak”, „(element złożony)”, „(brak)”. */
export function displayRaw(raw: unknown): string {
  if (raw === undefined || raw === null) return '(brak)';
  const s = scalar(raw);
  return s === null ? '(element złożony)' : `„${s.trim()}”`;
}

const FLAGS = [['P_16', 'p16'], ['P_17', 'p17'], ['P_18', 'p18'], ['P_18A', 'p18a'], ['P_23', 'p23']] as const;

function readExemption(raw: unknown): Fa3Annotations['exemption'] | undefined {
  if (!isNode(raw)) return undefined;
  const p19 = readTWybor1(raw.P_19);
  const p19n = readTWybor1(raw.P_19N);
  const bases = EXEMPTION_BASIS_KINDS.filter((k) => raw[k] !== undefined && raw[k] !== null);
  if (p19 === 'yes' && p19n === 'absent' && bases.length === 1) {
    const kind = bases[0]!;
    const basis = scalar(raw[kind])?.trim();
    return basis ? { kind, basis } : undefined;
  }
  if (p19n === 'yes' && p19 === 'absent' && bases.length === 0) return null;
  return undefined;
}

function readNewMeansOfTransport(raw: unknown): boolean | undefined {
  if (!isNode(raw)) return undefined;
  const p22 = readTWybor1(raw.P_22);
  const p22n = readTWybor1(raw.P_22N);
  if (p22 === 'yes' && p22n === 'absent') return true;
  if (p22n === 'yes' && p22 === 'absent') return false;
  return undefined;
}

function readMarginScheme(raw: unknown): Fa3Annotations['marginScheme'] | undefined {
  if (!isNode(raw)) return undefined;
  const p = readTWybor1(raw.P_PMarzy);
  const pn = readTWybor1(raw.P_PMarzyN);
  const present = MARGIN_SCHEMES.filter((k) => raw[k] !== undefined && raw[k] !== null);
  if (p === 'yes' && pn === 'absent' && present.length === 1 && readTWybor1(raw[present[0]!]) === 'yes') return present[0]!;
  if (pn === 'yes' && p === 'absent' && present.length === 0) return null;
  return undefined;
}

/**
 * Adnotacje z pliku. Każda flaga osobno: jedna nieczytelna nie kasuje
 * pozostałych (PDF i korekta dostają to, co odczytano), ale każdy problem
 * zatrzymuje fakturę w JPK.
 */
export function readFa3Annotations(raw: unknown): { annotations: Fa3Annotations; problems: string[] } {
  if (!isNode(raw)) return { annotations: {}, problems: ['brak sekcji Adnotacje (P_16–P_23)'] };
  const annotations: Fa3Annotations = {};
  const problems: string[] = [];
  for (const [field, key] of FLAGS) {
    const value = readTWybor1_2(raw[field]);
    if (value === null) problems.push(`${field} ${displayRaw(raw[field])}`);
    else annotations[key] = value;
  }
  const exemption = readExemption(raw.Zwolnienie);
  if (exemption === undefined) problems.push('zwolnienie (P_19 z P_19A/B/C albo P_19N) niejednoznaczne');
  else annotations.exemption = exemption;
  const transport = readNewMeansOfTransport(raw.NoweSrodkiTransportu);
  if (transport === undefined) problems.push('nowe środki transportu (P_22 albo P_22N) niejednoznaczne');
  else annotations.newMeansOfTransport = transport;
  const margin = readMarginScheme(raw.PMarzy);
  if (margin === undefined) problems.push('procedura marży (PMarzy) niejednoznaczna');
  else annotations.marginScheme = margin;
  return { annotations, problems };
}

/** Klucze FaktWay (`fa3_data.annotations`) — liczby 1|2, jak w fakturach z aplikacji. */
export function invoiceAnnotationsFromFa3(a: Fa3Annotations): InvoiceAnnotations {
  const out: InvoiceAnnotations = {};
  if (a.p16 !== undefined) out.cashMethod = a.p16;
  if (a.p17 !== undefined) out.selfInvoicing = a.p17;
  if (a.p18 !== undefined) out.reverseCharge = a.p18;
  if (a.p18a !== undefined) out.splitPayment = a.p18a;
  if (a.p23 !== undefined) out.simplifiedProcedure = a.p23;
  if (a.exemption) {
    out.vatExemptionBasis = a.exemption.basis;
    out.vatExemptionBasisKind = a.exemption.kind;
  }
  if (a.newMeansOfTransport !== undefined) out.newMeansOfTransport = a.newMeansOfTransport ? 1 : 2;
  if (a.marginScheme) out.marginScheme = a.marginScheme;
  return out;
}

const MARGIN_LABEL: Record<MarginScheme, string> = {
  P_PMarzy_2: 'procedura marży dla biur podróży (P_PMarzy_2)',
  P_PMarzy_3_1: 'procedura marży — towary używane (P_PMarzy_3_1)',
  P_PMarzy_3_2: 'procedura marży — dzieła sztuki (P_PMarzy_3_2)',
  P_PMarzy_3_3: 'procedura marży — przedmioty kolekcjonerskie i antyki (P_PMarzy_3_3)',
};

const isYes = (v: unknown) => v === 1 || v === true;

/**
 * Adnotacje, których JPK FaktWay nie wykazuje — JPK_FA i JPK_V7M (wspólne
 * `amountsOf`) odmawiają. JPK_FA(4) umiałby wpisać P_23 i P_106E_*, ale
 * JPK_V7M nie ma TT_D / MR_T / MR_UZ ani kwot marży — odmowa w obu, żeby
 * nikt nie „naprawił” tylko jednego pliku.
 */
export function annotationsJpkCannotExpress(
  a?: { simplifiedProcedure?: unknown; newMeansOfTransport?: unknown; marginScheme?: unknown } | null,
): string[] {
  if (!a) return [];
  const out: string[] = [];
  if (isYes(a.simplifiedProcedure)) out.push('procedura trójstronna (P_23)');
  if (isYes(a.newMeansOfTransport)) out.push('dostawa nowych środków transportu (P_22)');
  if (typeof a.marginScheme === 'string' && a.marginScheme in MARGIN_LABEL) out.push(MARGIN_LABEL[a.marginScheme as MarginScheme]);
  return out;
}

const AUTHORIZED_ROLE: Record<string, string> = {
  '1': 'organ egzekucyjny',
  '2': 'komornik sądowy',
  '3': 'przedstawiciel podatkowy',
};

/** Oznaczenia, których JPK FaktWay nie wykazuje (V7M wymaga ich w wierszu sprzedaży). */
export function markersJpkCannotExpress(m?: Fa3Markers | null): string[] {
  if (!m) return [];
  const out: string[] = [];
  if (m.fp) out.push('faktura do paragonu (FP)');
  if (m.tp) out.push('powiązania między nabywcą a sprzedawcą (TP)');
  if (m.authorizedEntityRole !== undefined) {
    const role = AUTHORIZED_ROLE[m.authorizedEntityRole];
    out.push(`podmiot upoważniony${role ? ` — ${role}` : ''} (RolaPU ${m.authorizedEntityRole})`);
  }
  if (m.gtu?.length) out.push(`oznaczenie GTU w pozycjach (${m.gtu.join(', ')})`);
  if (m.procedures?.length) out.push(`procedura w pozycjach (${m.procedures.join(', ')})`);
  return out;
}

/**
 * P_19 (zwolnienie) zgodne ze stawkami: podstawa ⇔ co najmniej jedna pozycja
 * „zw”. Stawka spoza FaktWay w którejś pozycji → `false` (rozstrzyga odmowa
 * stawki, z właściwym powodem).
 */
export function exemptionMismatch(a: { vatExemptionBasis?: string } | undefined, rates: readonly string[]): boolean {
  const normalized = rates.map((r) => r.trim().toLowerCase());
  if (normalized.some((r) => !isVatRate(r))) return false;
  const hasZw = normalized.includes('zw');
  const hasBasis = Boolean(a?.vatExemptionBasis?.trim());
  return hasZw !== hasBasis;
}

/** Jeden odczyt `fa3_data.annotations` dla JPK (pobieranie danych i gotowość paczki). */
export function jpkAnnotationsFromJson(raw: unknown): JpkInvoiceAnnotations | undefined {
  if (!isNode(raw)) return undefined;
  const out: JpkInvoiceAnnotations = {};
  if (raw.splitPayment === 1) out.splitPayment = true;
  if (raw.cashMethod === 1) out.cashMethod = true;
  if (typeof raw.vatExemptionBasis === 'string' && raw.vatExemptionBasis.trim()) {
    out.vatExemptionBasis = raw.vatExemptionBasis.trim();
    if (typeof raw.vatExemptionBasisKind === 'string' &&
        (EXEMPTION_BASIS_KINDS as readonly string[]).includes(raw.vatExemptionBasisKind)) {
      out.vatExemptionBasisKind = raw.vatExemptionBasisKind as ExemptionBasisKind;
    }
  }
  // Jawne 2 z pliku to „nie” (false); brak klucza — FaktWay wylicza sam (np. P_18 z pozycji).
  for (const key of ['selfInvoicing', 'reverseCharge', 'simplifiedProcedure', 'newMeansOfTransport'] as const) {
    if (raw[key] === 1) out[key] = true;
    else if (raw[key] === 2) out[key] = false;
  }
  if (typeof raw.marginScheme === 'string' && (MARGIN_SCHEMES as readonly string[]).includes(raw.marginScheme)) {
    out.marginScheme = raw.marginScheme as MarginScheme;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Oznaczenia z pliku: FP i TP (Fa), podmiot upoważniony (Faktura), GTU
 * i Procedura (FaWiersz). Nieczytelne FP/TP → problem.
 */
export function readFa3Markers(
  root: XmlNode,
  fa: XmlNode,
  lines: readonly XmlNode[],
): { markers?: Fa3Markers; problems: string[] } {
  const markers: Fa3Markers = {};
  const problems: string[] = [];
  for (const [field, key] of [['FP', 'fp'], ['TP', 'tp']] as const) {
    const v = readTWybor1(fa[field]);
    if (v === 'yes') markers[key] = true;
    else if (v === 'invalid') problems.push(`${field} ${displayRaw(fa[field])}`);
  }
  const pu = root.PodmiotUpowazniony;
  if (pu !== undefined && pu !== null) {
    markers.authorizedEntityRole = (isNode(pu) ? scalar(pu.RolaPU)?.trim() : null) || '?';
  }
  const collect = (field: 'GTU' | 'Procedura') => {
    const values = lines.flatMap((w) => {
      const raw = w[field];
      const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
      return list.map((v) => scalar(v)?.trim() || '(element złożony)');
    });
    return [...new Set(values)];
  };
  const gtu = collect('GTU');
  if (gtu.length) markers.gtu = gtu;
  const procedures = collect('Procedura');
  if (procedures.length) markers.procedures = procedures;
  return { ...(Object.keys(markers).length ? { markers } : {}), problems };
}
