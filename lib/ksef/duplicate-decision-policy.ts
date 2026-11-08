/**
 * Polityka decyzji klienta i operatora (lustro `ksef_duplicate_decision_blocker`,
 * 2.1.2; 00156 4.5): `duplicateDecisionOptions` i jej części.
 *
 * Część barelu `./duplicate-decision` (plan usprawnień 3.7b). Spoza
 * `lib/ksef/duplicate-decision*.ts` importuj tylko z barelu `@/lib/ksef/duplicate-decision`.
 * CZYSTY moduł (komponenty klienckie i worker): bez bazy, KSeF, Node i `duplicate-verdict.ts`.
 */

import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import type { KsefEnvironment } from '@/types/ksef';

import {
  ORIGINAL_RECHECK_KINDS,
  originalAssignedDay,
  originalHasUncorrectableLine,
  type DuplicateOriginalOffer,
  type OriginalGateProblem,
  type OriginalPreview,
} from './duplicate-check';
import {
  duplicateCheckAllows,
  duplicateOriginalOffer,
  isRecord,
  originalRecheckNeeded,
  ownHistoryInSubmissions,
  programOf,
  str,
  trimmed,
} from './duplicate-decision-jsonb';
import { decisionOf, duplicateMarker, isCorrectableBuyer, oneOf, retiredRow } from './duplicate-decision-rows';
import { documentNumber, duplicateEnvLabel, sqlText } from './duplicate-decision-sql-texts';
import { DUPLICATE_DECISION_TEXTS } from './duplicate-decision-texts';
import {
  DUPLICATE_DECISION_BLOCKER_CODES,
  type ComparisonRow,
  type DuplicateChoice,
  type DuplicateDecisionBlockerCode,
  type DuplicateDecisionFacts,
  type DuplicateDecisionInvoiceRow,
  type DuplicateDecisionReason,
  type DuplicateDecisionRefusal,
  type DuplicateDecisionSubmissionRow,
  type DuplicateDecisionView,
  type DuplicateOriginalViewData,
  type DuplicateRecordIntro,
  type DuplicateRefusalDetail,
} from './duplicate-decision-types';
import { isCorrectionHeldForEnv } from './kind-holds';

// ─── Polityka decyzji (lustro `ksef_duplicate_decision_blocker`, 2.1.2) ──────

export interface DuplicateDecisionOptionsInput {
  facts: DuplicateDecisionFacts;
  /** Klient w panelu albo operator (`/admin/ksef`, decyzja przekazana przez klienta). */
  actor: 'client' | 'operator';
  /** Rola zalogowanej osoby: właściciel albo administrator (`canManageKsefSend`). Operator jej nie potrzebuje. */
  canManage: boolean;
  /** `configuredKsefEnvironment()` serwera; `null` — nieznane. */
  environment: KsefEnvironment | null;
  /** Chwila odczytu: PR C liczy z niej `pastPeriod` (okres oryginału wcześniejszy niż bieżący miesiąc w Polsce). */
  now: Date;
}

const toNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const digitsOf = (v: string | null): string | null => {
  const d = v ? v.replace(/\D/g, '') : '';
  return d.length > 0 ? d : null;
};

const sameText = (a: string | null, b: string | null): boolean | null => (a !== null && b !== null ? a === b : null);

/** Tabela porównania (2.2.2) i dwa porównania, od których zależy „Rozumiem skutki”. */
interface Comparison {
  rows: ComparisonRow[];
  /** NIP nabywcy po samych cyfrach; `null` — nieznany po którejś stronie. */
  nipSame: boolean | null;
  /** Kwota brutto w tej samej znanej walucie; `null` — kwota albo waluta nieznana. */
  grossSame: boolean | null;
}

/**
 * Sześć wierszy PR B: numer, data wystawienia, nabywca, NIP nabywcy, kwota
 * brutto, program (`programKsef` — kolumna „W KSeF” wiersza „Program”).
 */
function comparisonOf(inv: DuplicateDecisionInvoiceRow, summary: Record<string, unknown>, programKsef: string | null): Comparison {
  const L = DUPLICATE_DECISION_TEXTS.ROW_LABELS;
  const buyerData = isRecord(inv.buyer_data) ? inv.buyer_data : null;

  const ksefNumberText = trimmed(summary.number);
  const oursNumber = trimmed(inv.internal_number);
  const ksefDate = trimmed(summary.issueDate);
  const oursDate = trimmed(inv.issue_date);
  const ksefBuyer = trimmed(summary.buyerName);
  const oursBuyer = trimmed(buyerData?.name);
  const ksefNip = trimmed(summary.buyerNip);
  const oursNip = trimmed(inv.buyer_nip);
  const nipK = digitsOf(ksefNip);
  const nipO = digitsOf(oursNip);
  const nipSame = sameText(nipK, nipO);

  const ksefGross = toNumber(summary.gross);
  const oursGross = toNumber(inv.gross_total);
  const ksefCurrency = trimmed(summary.currency);
  const oursCurrency = trimmed(inv.currency);
  // Obie kwoty i obie waluty znane: inna waluta — „różni się” (decyzja 12: to „kwota się różni”), ta sama — porównanie
  // kwot. Kwota albo waluta nieznana — „bez porównania” (null); „Rozumiem skutki” i tak wymagane (`grossSame !== true`).
  const grossSame = ksefGross === null || oursGross === null || ksefCurrency === null || oursCurrency === null
    ? null
    : ksefCurrency === oursCurrency && ksefGross.toFixed(2) === oursGross.toFixed(2);
  const money = (value: number | null, currency: string | null): string | null =>
    value === null ? null : currency ? `${value.toFixed(2)} ${currency}` : value.toFixed(2);

  const rows: ComparisonRow[] = [
    { label: L.number, ksef: ksefNumberText, ours: oursNumber, same: sameText(ksefNumberText, oursNumber) },
    { label: L.issueDate, ksef: ksefDate, ours: oursDate, same: sameText(ksefDate, oursDate) },
    { label: L.buyer, ksef: ksefBuyer, ours: oursBuyer, same: sameText(ksefBuyer, oursBuyer) },
    { label: L.buyerNip, ksef: ksefNip, ours: oursNip, same: nipSame },
    { label: L.gross, ksef: money(ksefGross, ksefCurrency), ours: money(oursGross, oursCurrency), same: grossSame },
    { label: L.program, ksef: programKsef, ours: 'FaktWay', same: null },
  ];
  return { rows, nipSame, grossSame };
}

/** „Rozumiem skutki” PR B (decyzje 7 i 12) — także oferty `pair`, `released` i `review-pair`. */
const prBConfirmation = (c: Comparison): Record<DuplicateChoice, boolean> => ({
  // „Inna sprzedaż” przy tym samym albo nieznanym NIP nabywcy.
  other_sale: c.nipSame !== false,
  // „Ta sama sprzedaż” przy innym albo nieznanym NIP albo kwocie, która się różni (także waluta, wartość nieznana).
  same_sale: c.nipSame !== true || c.grossSame !== true,
});

type RecheckDetail = Pick<DuplicateRefusalDetail, 'recheckKind' | 'recheckAt'>;
type Refuse = (refusal: DuplicateDecisionRefusal, message: string | null, extra?: RecheckDetail) => DuplicateDecisionView;

/** Odmowa środowiska — nieznane środowisko aplikacji albo inne środowisko sprawdzenia oryginału (jak RPC). */
function environmentRefusal(
  environment: KsefEnvironment | null,
  checkEnv: unknown,
  k: string,
  nr: string,
  refused: Refuse,
): DuplicateDecisionView | null {
  if (environment === null) return refused('env-unknown', KSEF_SEND_MESSAGES.envUnknown);
  if (checkEnv !== environment) {
    return refused('env', sqlText('ENV', k, duplicateEnvLabel(checkEnv), duplicateEnvLabel(environment), nr));
  }
  return null;
}

/**
 * Kod blokady SQL, którego TS nie obsłużył wcześniej (wyścig — baza ma ostatnie
 * słowo): odmowa z tekstem kodu; kod spoza listy 00156 → `state-unknown`.
 */
function blockerRefusal(code: string, k: string, nr: string, refused: Refuse): DuplicateDecisionView {
  if (!(DUPLICATE_DECISION_BLOCKER_CODES as readonly string[]).includes(code)) {
    return refused('state-unknown', DUPLICATE_DECISION_TEXTS.FAKTFLOW.READ_FAILED(nr));
  }
  const blocker = code as DuplicateDecisionBlockerCode;
  switch (blocker) {
    case 'not-found':
      return refused(blocker, KSEF_SEND_MESSAGES.notFound);
    case 'reason':
      // Jak odmowa `reason` w TS: notatka PR A z karty.
      return refused(blocker, null);
    case 'known-stale':
    case 'own-history':
    case 'known-now':
      return refused(blocker, sqlText(blocker, k, nr));
    case 'cross-tenant':
      return refused(blocker, sqlText(blocker, nr, nr));
    default:
      return refused(blocker, sqlText(blocker, nr));
  }
}

/** `recheckNeeded` znacznika dla tekstu operatora (`recheckPending`) — rodzaj z listy 4.7b i czas; inaczej `null`. */
function recheckDetailOf(check: Record<string, unknown>): RecheckDetail {
  const flag = isRecord(check.recheckNeeded) ? check.recheckNeeded : null;
  return {
    recheckKind: flag ? oneOf(flag.kind, ORIGINAL_RECHECK_KINDS) : null,
    recheckAt: flag ? str(flag.at) : null,
  };
}

/** `MM.RRRR` wcześniejszy niż bieżący miesiąc w Polsce (Europe/Warsaw) w chwili `now`; zły zapis okresu → `false`. */
function isPastPeriod(period: unknown, now: Date): boolean {
  const p = typeof period === 'string' ? /^(\d{2})\.(\d{4})$/.exec(period) : null;
  const today = /^(\d{4})-(\d{2})-\d{2}$/.exec(todayInWarsaw(now));
  if (!p || !today) return false;
  return Number(p[2]) * 12 + Number(p[1]) < Number(today[1]) * 12 + Number(today[2]);
}

/** Wiersz „Data sprzedaży” (`NULL` = jak data wystawienia — nie „—”); bez porównania. */
function saleDateRow(preview: OriginalPreview, inv: DuplicateDecisionInvoiceRow): ComparisonRow {
  const FF = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
  return {
    label: FF.ROW_SALE_DATE,
    ksef: trimmed(preview.saleDate) ?? FF.SALE_DATE_AS_ISSUE,
    ours: trimmed(inv.sale_date) ?? FF.SALE_DATE_AS_ISSUE,
    same: null,
  };
}

interface FaktflowContext {
  input: DuplicateDecisionOptionsInput;
  inv: DuplicateDecisionInvoiceRow;
  subs: readonly DuplicateDecisionSubmissionRow[];
  marker: DuplicateDecisionSubmissionRow;
  /** Surowy `original_check` znacznika (przeszedł `duplicateCheckAllows`). */
  check: Record<string, unknown>;
  k: string;
  nr: string;
  sha256: string;
  refused: Refuse;
}

/** Część widoku wspólna dla `decidable` i `review` przy `faktflow-original` (5.5). */
function faktflowViewParts(ctx: FaktflowContext, offer: DuplicateOriginalOffer, ownHistoryDb: boolean) {
  const { inv, check, k, input } = ctx;
  const FF = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
  const summary = check.summary as Record<string, unknown>;
  const gate = isRecord(check.importGate) ? check.importGate : null;
  // Podgląd z `importGate.preview` — strona nie czyta archiwum (INV-13).
  const preview = gate && isRecord(gate.preview) ? (gate.preview as unknown as OriginalPreview) : null;
  const comparison = comparisonOf(inv, summary, offer === 'released' ? FF.PROGRAM_RELEASED : 'FaktWay');
  if (preview) comparison.rows.splice(2, 0, saleDateRow(preview, inv));
  const sameContent = typeof check.sameContentExceptHeader === 'boolean' ? check.sameContentExceptHeader : null;
  const recordOnly = offer === 'record' || offer === 'review-record';
  // Wstęp „tylko zapis”: własna historia (JSON albo baza) ma pierwszeństwo przed tą samą treścią (I1).
  const recordIntro: DuplicateRecordIntro | undefined = recordOnly
    ? (check.ownHistory === true || ownHistoryDb ? 'own' : 'same')
    : undefined;
  const choices: readonly DuplicateChoice[] = recordOnly ? ['same_sale'] : ['same_sale', 'other_sale'];
  const needsConfirmation: Record<DuplicateChoice, boolean> = recordOnly
    ? { other_sale: false, same_sale: sameContent !== true }
    : prBConfirmation(comparison);
  const original: DuplicateOriginalViewData = {
    preview,
    assignedDay: originalAssignedDay({ acquiredAt: str(check.acquiredAt) }, k),
    pastPeriod: preview ? isPastPeriod(preview.period, input.now) : false,
  };
  return {
    comparison: comparison.rows,
    markedDifference: comparison.rows.some((row) => row.same === false),
    sameContent,
    needsConfirmation,
    choices,
    original,
    // `buyerIdKind` nieznany (brak podglądu) — korekty nie obiecujemy (∉ nip, vat-ue).
    correctionForPerson: !isCorrectableBuyer(preview?.buyerIdKind),
    // Pozycja zw / stawka spoza FaktWay / brak ceny netto: korekty K nie obiecujemy (D-A4-1b-3-KORZW).
    correctionForRate: originalHasUncorrectableLine(gate),
    // Środowisko jest tu znane (odmowa `env-unknown` stoi wcześniej).
    heldCorrections: input.environment !== null && isCorrectionHeldForEnv(input.environment),
    ...(recordIntro ? { recordIntro } : {}),
  };
}

/**
 * `faktflow-original` po kroku 10 (5.5, kody w kolejności 4.5): blokady SQL nie
 * odczytano → `state-unknown`; `known-now`, `cross-tenant` z blokady SQL;
 * `recheck-needed` z JSON (lustro 11c) albo z blokady; krok 12 pominięty —
 * własna historia z bazy wybiera ofertę „tylko zapis”; `payments` z wiersza
 * albo z blokady; oferta `review-*`: klient — `provenance-review`, operator —
 * środowisko (M9), potem widok `review`; dalej środowisko i rola jak PR B; kod
 * blokady SQL nieobsłużony wyżej odmawia (wyścig — baza ma ostatnie słowo).
 */
function faktflowOriginalOptions(ctx: FaktflowContext): DuplicateDecisionView {
  const { input, inv, subs, marker, check, k, nr, sha256, refused } = ctx;
  const { actor, environment } = input;
  const blocker = input.facts.sqlBlocker;
  const FF = DUPLICATE_DECISION_TEXTS.FAKTFLOW;

  // 1. Blokady nie odczytano — fail-closed, także dla operatora.
  if (blocker === undefined) return refused('state-unknown', FF.READ_FAILED(nr));
  // 2. 11a known-now i 11b cross-tenant — tylko z blokady SQL (TS ich nie liczy, INV-9, INV-15).
  if (blocker === 'known-now') return refused('known-now', sqlText('known-now', k, nr));
  if (blocker === 'cross-tenant') return refused('cross-tenant', sqlText('cross-tenant', nr, nr));
  //    11c recheck-needed — lustro z JSON (brak albo zły kształt bramy, znacznik `recheckNeeded`) albo słowo bazy.
  if (originalRecheckNeeded(check) || blocker === 'recheck-needed') {
    return refused('recheck-needed', sqlText('recheck-needed', nr), recheckDetailOf(check));
  }
  // 3. Krok 12 (own-history) pominięty: własna historia w bazie daje ofertę „tylko zapis” (T3, INV-19).
  const ownHistoryDb = ownHistoryInSubmissions(subs, marker);
  // 4. Krok 13 payments: `paid_amount` faktury albo wiersze `payments` z blokady SQL (INV-17) — przed przeglądem.
  const paid = toNumber(inv.paid_amount);
  if ((inv.paid_amount != null && paid !== 0) || blocker === 'payments') return refused('payments', sqlText('payments', nr));
  // 5. Oferta — lustro `ksef_duplicate_original_offer` (ta sama dla powiadomień i operatora).
  const offer = duplicateOriginalOffer(check, ownHistoryDb);
  // `allows` przeszło, powód faktflow-original — oferta zawsze jest; brak = niespójne dane, notatka PR A.
  if (offer === null) return refused('reason', null);
  if (offer === 'review-pair' || offer === 'review-record') {
    // Klient: przegląd pliku — blokada SQL `provenance-review` stoi przed odmowami aplikacji.
    if (actor !== 'operator') return refused('provenance-review', sqlText('provenance-review', nr));
    // M9: środowisko PRZED widokiem przeglądu (RPC i tak odmówiłoby ENV).
    const env = environmentRefusal(environment, check.env, k, nr, refused);
    if (env) return env;
    // Baza ma ostatnie słowo: inny kod niż provenance-review (wyścig) odmawia.
    if (blocker !== null && blocker !== 'provenance-review') return blockerRefusal(blocker, k, nr, refused);
    const parts = faktflowViewParts(ctx, offer, ownHistoryDb);
    const gate = isRecord(check.importGate) ? check.importGate : null;
    return {
      kind: 'review',
      offer,
      // Brama jest tu poprawna (inaczej recheck-needed wyżej): `problems` to tablica napisów.
      problems: Array.isArray(gate?.problems) ? [...(gate.problems as OriginalGateProblem[])] : [],
      invoiceNumber: inv.internal_number,
      originalKsefNumber: k,
      originalSha256: sha256,
      comparison: parts.comparison,
      original: parts.original,
      choices: parts.choices,
      needsConfirmation: parts.needsConfirmation,
      sameContent: parts.sameContent,
      markedDifference: parts.markedDifference,
      heldCorrections: parts.heldCorrections,
      program: 'FaktWay',
      releasable: offer === 'review-pair',
      correctionForPerson: parts.correctionForPerson,
      correctionForRate: parts.correctionForRate,
      ...(parts.recordIntro ? { recordIntro: parts.recordIntro } : {}),
    };
  }
  // 6. Środowisko aplikacji, środowisko sprawdzenia oryginału, rola klienta — jak PR B.
  const env = environmentRefusal(environment, check.env, k, nr, refused);
  if (env) return env;
  if (actor === 'client' && !input.canManage) return refused('role', DUPLICATE_DECISION_TEXTS.ROLE);
  // 7. Kod blokady SQL nieobsłużony wyżej (wyścig) — baza ma ostatnie słowo.
  if (blocker !== null) return blockerRefusal(blocker, k, nr, refused);

  const parts = faktflowViewParts(ctx, offer, ownHistoryDb);
  return {
    kind: 'decidable',
    reason: 'faktflow-original',
    invoiceNumber: inv.internal_number,
    originalKsefNumber: k,
    originalSha256: sha256,
    comparison: parts.comparison,
    markedDifference: parts.markedDifference,
    sameContent: parts.sameContent,
    needsConfirmation: parts.needsConfirmation,
    // Po oddaniu plik „nie powstał w FaktWay” — program nieznany (dialogi PR B z `program = null`).
    program: offer === 'released' ? null : 'FaktWay',
    knownInvoice: null,
    heldCorrections: parts.heldCorrections,
    offer,
    mode: offer === 'released' ? 'no-import' : 'import',
    choices: parts.choices,
    original: parts.original,
    correctionForPerson: parts.correctionForPerson,
    correctionForRate: parts.correctionForRate,
    ...(parts.recordIntro ? { recordIntro: parts.recordIntro } : {}),
  };
}

/**
 * Co klient (albo operator) może zrobić z fakturą przy nierozstrzygniętym 440.
 * Kolejność odmów = blokada SQL (2.1.2), potem nieznane środowisko, inne
 * środowisko sprawdzenia oryginału i — na końcu, tylko klient — rola: członek
 * firmy widzi prawdziwą blokadę. Szkic z zapisaną decyzją daje widok `decided`
 * (ponowienie po zgubionej odpowiedzi; RPC odpowiada wtedy `already_decided`).
 * PR C: `faktflow-original` — `faktflowOriginalOptions` (kody 00156, 4.5).
 */
export function duplicateDecisionOptions(input: DuplicateDecisionOptionsInput): DuplicateDecisionView {
  const { facts, actor, environment } = input;
  const inv = facts.invoice;
  const subs = facts.submissions;
  const marker = duplicateMarker(subs);
  const markerCheck = marker && isRecord(marker.original_check) ? marker.original_check : null;
  const knownFromCheck = markerCheck && isRecord(markerCheck.knownInvoice) ? markerCheck.knownInvoice : null;

  const refused: Refuse = (refusal, message, extra) => {
    if (actor !== 'operator') return { kind: 'refused', refusal, message };
    const knownNumber = markerCheck?.reason === 'known-number'
      ? facts.knownInvoice?.internalNumber ?? str(knownFromCheck?.internalNumber) ?? 'bez numeru'
      : null;
    return {
      kind: 'refused',
      refusal,
      message,
      detail: {
        originalKsefNumber: marker?.original_ksef_number ?? null,
        reason: typeof markerCheck?.reason === 'string' ? markerCheck.reason : null,
        checkEnv: typeof markerCheck?.env === 'string' ? markerCheck.env : null,
        environment,
        paidAmount: inv ? toNumber(inv.paid_amount) : null,
        knownInvoiceNumber: knownNumber,
        ...(extra ?? {}),
      },
    };
  };

  // 1. not-found (RPC: P0002 przed wszystkim innym).
  if (!inv || inv.direction !== 'outgoing') return refused('not-found', KSEF_SEND_MESSAGES.notFound);

  // Idempotencja (RPC krok 2): zapisana decyzja — nie odmowa, tylko jej widok.
  const taken = retiredRow(subs);
  const decided = taken ? decisionOf(taken) : null;
  if (taken && decided) {
    return {
      kind: 'decided',
      choice: decided.choice,
      via: decided.via,
      at: decided.at,
      originalKsefNumber: taken.original_ksef_number,
      // PR C: decyzja `faktflow-original` niesie tryb, ofertę i fakturę K; decyzja PR B — bez tych kluczy.
      ...(decided.mode !== null || decided.offer !== null
        ? {
            mode: decided.mode,
            offer: decided.offer,
            importedInvoiceId: decided.importedInvoiceId,
            retiredInternalNumber: decided.retiredInternalNumber,
          }
        : {}),
    };
  }

  const nr = documentNumber(inv.internal_number);
  // 2. not-pending
  if (inv.ksef_status !== 'failed' || inv.last_error_code !== 'KSEF_DUPLICATE_RECONCILE') {
    return refused('not-pending', sqlText('not-pending', nr));
  }
  // 3. in-ksef
  if (inv.ksef_number != null || subs.some((s) => s.status === 'accepted' || s.response_ksef_number != null)) {
    return refused('in-ksef', sqlText('in-ksef', nr));
  }
  // 4. kind
  if ((inv.invoice_kind ?? 'regular') !== 'regular') return refused('kind', sqlText('kind', nr));
  // 5. billing
  if (inv.stripe_invoice_id != null) return refused('billing', sqlText('billing', nr));
  // 6. offline (reset ich nie czyści, 00132 je mrozi)
  if (inv.offline_idempotency_key != null || inv.offline_qr_offline != null || inv.offline_qr_certyfikat != null) {
    return refused('offline', sqlText('offline', nr));
  }
  // 7. no-marker
  if (!marker || marker.original_ksef_number == null) return refused('no-marker', sqlText('no-marker', nr));
  const k = marker.original_ksef_number;
  // 8. conflicting-originals: wpis w dowolnym stanie z innym numerem oryginału.
  if (subs.some((s) => s.original_ksef_number != null && s.original_ksef_number !== k)) {
    return refused('conflicting-originals', sqlText('conflicting-originals', nr));
  }
  // 9. no-check (znacznik sprzed 00144)
  if (marker.original_check === null || marker.original_check === undefined) return refused('no-check', sqlText('no-check', nr));
  // 10. reason: dane oryginału, powód i własna historia w JSON — zostaje notatka PR A.
  if (!markerCheck || !duplicateCheckAllows(markerCheck, null)) return refused('reason', null);
  const check = markerCheck;
  const reason = check.reason as DuplicateDecisionReason;
  // 11. known-stale — tylko przy powodzie known-number (C2): Y musi nadal mieć K i być przyjęta.
  if (reason === 'known-number') {
    const known = facts.knownInvoice;
    const expectedId = knownFromCheck ? knownFromCheck.id : null;
    if (!known || !known.holdsOriginal || known.id !== expectedId) {
      return refused('known-stale', sqlText('known-stale', k, nr));
    }
  }
  const sha256 = check.sha256 as string;
  // PR C (00156): faktflow-original — known-now, cross-tenant, recheck-needed, oferta, przegląd.
  if (reason === 'faktflow-original') {
    return faktflowOriginalOptions({ input, inv, subs, marker, check, k, nr, sha256, refused });
  }
  // 12. own-history — sprawdzane na wpisach faktury, nie z JSON (lustro `ksef_duplicate_own_history`, 4.3).
  if (ownHistoryInSubmissions(subs, marker)) return refused('own-history', sqlText('own-history', k, nr));
  // 13. payments — sesja klienta widzi tylko `paid_amount`; wiersze `payments` sprawdza RPC.
  const paid = toNumber(inv.paid_amount);
  if (inv.paid_amount != null && paid !== 0) return refused('payments', sqlText('payments', nr));
  // Środowisko aplikacji, potem środowisko sprawdzenia oryginału, potem rola klienta.
  const env = environmentRefusal(environment, check.env, k, nr, refused);
  if (env) return env;
  if (actor === 'client' && !input.canManage) return refused('role', DUPLICATE_DECISION_TEXTS.ROLE);

  const summary = check.summary as Record<string, unknown>;
  const program = programOf(summary);
  const comparison = comparisonOf(inv, summary, program);

  const known = reason === 'known-number' && facts.knownInvoice
    ? { id: facts.knownInvoice.id, internalNumber: facts.knownInvoice.internalNumber }
    : null;
  return {
    kind: 'decidable',
    reason,
    invoiceNumber: inv.internal_number,
    originalKsefNumber: k,
    originalSha256: sha256,
    comparison: comparison.rows,
    markedDifference: comparison.rows.some((row) => row.same === false),
    // no-own-file: FaktWay nie ma pliku próby — treści nie porównano.
    sameContent: reason === 'known-number' && typeof check.sameContentExceptHeader === 'boolean' ? check.sameContentExceptHeader : null,
    needsConfirmation: prBConfirmation(comparison),
    program,
    knownInvoice: known,
    // Środowisko jest tu znane (odmowa `env-unknown` wyżej).
    heldCorrections: environment !== null && isCorrectionHeldForEnv(environment),
    // PR C (5.5): pola oferty ustawione zawsze — powód PR B: bez oferty (9-argumentowe RPC), oba wybory, bez danych oryginału.
    offer: null,
    mode: null,
    choices: ['same_sale', 'other_sale'],
    original: null,
    correctionForPerson: false,
    correctionForRate: false,
  };
}
