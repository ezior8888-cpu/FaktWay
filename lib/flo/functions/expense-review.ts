/**
 * W-01 — paragon prosto z telefonu (krok 18 planu).
 *
 * Klient robi zdjęcie i o nim zapomina. Po dwudziestu sekundach dostaje
 * kartę: „Orlen, 312,40 zł — paliwo. Zaksięgowałem.” Cała robota po jego
 * stronie to jedno zdjęcie.
 *
 * TRZY AWARIE, KTÓRE TU ZAMYKAMY (część II.10 planu):
 *
 * 1. ZŁY ODCZYT. Wyblakły paragon termiczny, zdjęcie pod kątem, „312,40”
 *    odczytane jako „31 240”. Trzy niezależne sita: brak wymaganego pola,
 *    kontrola arytmetyczna i kontrola rzędu wielkości wobec historii u tego
 *    sprzedawcy. Każde z nich zamienia meldunek w pytanie.
 *
 * 2. WYDATEK PRYWATNY. O firmowości decyduje wyłącznie człowiek. Nieznany
 *    sprzedawca przy większej kwocie i kategorie z natury wątpliwe zawsze
 *    kończą się pytaniem — nawet gdy odczyt jest idealny.
 *
 * 3. ZAWIESZONE ZADANIE. Odczyt, który nie skończył się w trzy minuty, sam
 *    zamienia się w kartę z drogą wyjścia. Zdjęcie zostaje w archiwum
 *    niezależnie od wyniku, więc dokument nigdy nie ginie.
 */

import * as Sentry from '@sentry/nextjs';

import { formatMoneyPlain } from '@/lib/flo/money';
import { renderCopyVariant } from '@/lib/flo/copy';
import { floDb } from '@/lib/flo/db-types';
import { fingerprintOf } from '@/lib/flo/fingerprint';
import {
  productionRuleLearningSources,
  proposeRuleAfterReview,
} from '@/lib/flo/functions/expense-rules';
import { registerFloHandler } from '@/lib/flo/handlers';
import type { CreateProposalInput } from '@/lib/flo/proposals';
import { captureUndo } from '@/lib/flo/undo';
import { documentCurrency, HOME_CURRENCY } from '@/lib/ocr/currency';
import { readAllById } from '@/lib/pagination/keyset';
import { createAdminClient } from '@/lib/supabase/admin';

// ═══════════════════════════════════════════════════════════════
// Progi
// ═══════════════════════════════════════════════════════════════

/**
 * Poniżej tej pewności odczytu agent nie twierdzi, że wie, co przeczytał.
 * Schemat OCR zwraca `null` dla pól nieczytelnych, więc ta wartość dotyczy
 * odczytu jako całości.
 */
const CONFIDENCE_MIN = 0.7;

/** Tolerancja arytmetyczna: dwa grosze na zaokrągleniach po obu stronach. */
const ARITHMETIC_TOLERANCE = 0.02;

/** Ile razy kwota może odbiegać od typowej u tego sprzedawcy, zanim zapytamy. */
const MAGNITUDE_FACTOR = 5;

/** Ile dokumentów potrzeba, żeby mediana u sprzedawcy cokolwiek znaczyła. */
const HISTORY_MIN = 3;

/**
 * Kwota, powyżej której nieznany sprzedawca zawsze kończy się pytaniem.
 * Poniżej — drobne zakupy, przy których pytanie o każdy byłoby udręką.
 */
const UNKNOWN_SELLER_LIMIT_PLN = 500;

/** Po tylu minutach odczyt uznajemy za porzucony. */
export const OCR_STUCK_AFTER_MS = 3 * 60_000;

/**
 * Kategorie, w których pytamy ZAWSZE, niezależnie od reguł i pewności.
 * Nie dlatego, że OCR sobie nie radzi — dlatego, że to są zakupy, przy
 * których granica między firmowym a prywatnym jest cienka, a konsekwencje
 * pomyłki ponosi wyłącznie klient.
 */
const ALWAYS_ASK_CATEGORIES = new Set(['spozywcze', 'odziez', 'elektronika']);

// ═══════════════════════════════════════════════════════════════
// Ocena odczytu — funkcja czysta
// ═══════════════════════════════════════════════════════════════

export interface OcrFacts {
  sellerName: string | null;
  sellerNip: string | null;
  netAmount: number | null;
  vatAmount: number | null;
  grossAmount: number | null;
  issueDate: string | null;
  confidence: number | null;
  categoryLabel: string | null;
  /**
   * Waluta KWOT w tych faktach, nie dokumentu: faktura w euro przeliczona
   * kursem NBP ma tu „PLN”. Inna waluta znaczy, że kursu zabrakło i kwoty
   * są w walucie dokumentu. Brak = PLN.
   */
  amountCurrency?: string | null;
}

/** Jeden wcześniejszy dokument sprzedawcy — surowiec historii. */
export interface SellerHistoryEntry {
  expenseId: string;
  /**
   * Kwota brutto w złotych. `null` = waluta bez kursu: sprzedawca jest znany,
   * ale tej kwoty nie da się porównać ze złotówkami, więc nie wchodzi do mediany.
   */
  grossPln: number | null;
}

export interface SellerHistory {
  /**
   * Ile INNYCH dokumentów tego sprzedawcy klient ma w wydatkach — wszystkich,
   * nie tylko przejrzanych czy zaksięgowanych. Historia z `entries` liczy się
   * na nowo w karcie, już bez bieżącego wydatku.
   */
  count: number;
  /** Mediana kwoty brutto w złotych — mediana, nie średnia: jeden wybryk nie psuje. */
  medianGross: number;
  /** Ile kwot weszło do mediany. Brak = `count` (historia podana wprost). */
  medianBasis?: number;
  /**
   * Wiersze, z których historia powstała. Gdy są, karta przelicza historię
   * BEZ bieżącego wydatku — powstaje po jego zapisie, więc inaczej liczyłby
   * się sam ze sobą.
   */
  entries?: readonly SellerHistoryEntry[];
}

export type ExpenseIssue =
  | 'missing_rate'
  | 'low_confidence'
  | 'missing_field'
  | 'arithmetic'
  | 'magnitude'
  | 'unknown_seller'
  | 'sensitive_category';

export interface ExpenseAssessment {
  issues: ExpenseIssue[];
  /** true = agent pyta zamiast meldować. */
  needsQuestion: boolean;
  /** Zdanie dla człowieka: dlaczego pytam. */
  reason: string;
}

const ISSUE_REASON: Record<ExpenseIssue, string> = {
  missing_rate:
    'Kwota jest w obcej walucie, a kursu NBP do niej nie mam — do KPiR wejdzie dopiero z kwotą w złotych.',
  low_confidence: 'Zdjęcie jest słabo czytelne, więc nie ufam swojemu odczytowi.',
  missing_field: 'Nie odczytałem wszystkiego, czego potrzebuję.',
  arithmetic: 'Kwoty na paragonie mi się nie sumują.',
  magnitude: 'Ta kwota mocno odbiega od tego, co zwykle płacisz u tego sprzedawcy.',
  unknown_seller: 'Pierwszy raz widzę tego sprzedawcę, a kwota jest niemała.',
  sensitive_category: 'Przy takich zakupach nie zgaduję, czy to firmowy wydatek.',
};

export function assessExpense(
  facts: OcrFacts,
  history: SellerHistory,
): ExpenseAssessment {
  const issues: ExpenseIssue[] = [];

  // Kwoty w walucie bez kursu — PIERWSZE, bo to ono jest powodem na karcie
  // (`issues[0]`): dopóki kwota nie jest w złotych, reszta sit nie ma sensu,
  // a klient ma najpierw wiedzieć, czego brakuje.
  const inPln = amountCurrencyOf(facts) === HOME_CURRENCY;
  if (!inPln) {
    issues.push('missing_rate');
  }

  if (!facts.sellerName || facts.grossAmount === null || !facts.issueDate) {
    issues.push('missing_field');
  }

  if (facts.confidence !== null && facts.confidence < CONFIDENCE_MIN) {
    issues.push('low_confidence');
  }

  // Kontrola arytmetyczna. Odczyt, w którym netto plus VAT nie daje brutto,
  // jest wewnętrznie sprzeczny — jedna z tych liczb jest przekłamana i nie
  // wiadomo która.
  if (
    facts.netAmount !== null &&
    facts.vatAmount !== null &&
    facts.grossAmount !== null &&
    Math.abs(facts.netAmount + facts.vatAmount - facts.grossAmount) >
      ARITHMETIC_TOLERANCE
  ) {
    issues.push('arithmetic');
  }

  // Kontrola rzędu wielkości. To jest sito na klasyczny błąd OCR: przecinek
  // odczytany jako nic, przez co 312,40 zamienia się w 31 240.
  // Tylko dla złotówek: mediana jest w złotych, a sto euro to nie sto złotych.
  // Próg liczy kwoty, które WESZŁY do mediany — dokument bez kursu jej nie zasila.
  if (
    inPln &&
    facts.grossAmount !== null &&
    (history.medianBasis ?? history.count) >= HISTORY_MIN &&
    history.medianGross > 0
  ) {
    const ratio = facts.grossAmount / history.medianGross;
    if (ratio > MAGNITUDE_FACTOR || ratio < 1 / MAGNITUDE_FACTOR) {
      issues.push('magnitude');
    }
  }

  // Próg nieznanego sprzedawcy jest w złotych — kwoty w innej walucie
  // i tak kończą się pytaniem (`missing_rate`).
  if (
    inPln &&
    history.count === 0 &&
    facts.grossAmount !== null &&
    facts.grossAmount > UNKNOWN_SELLER_LIMIT_PLN
  ) {
    issues.push('unknown_seller');
  }

  if (facts.categoryLabel && ALWAYS_ASK_CATEGORIES.has(facts.categoryLabel)) {
    issues.push('sensitive_category');
  }

  return {
    issues,
    needsQuestion: issues.length > 0,
    reason: issues.length > 0 ? ISSUE_REASON[issues[0]!] : '',
  };
}

/**
 * Waluta kwot w faktach jako kod ISO; brak = PLN. Ta sama normalizacja co
 * przy zapisie wydatku (`documentCurrency`), żeby karta i baza nie rozjechały
 * się na „eur” czy pustym napisie.
 */
function amountCurrencyOf(facts: Pick<OcrFacts, 'amountCurrency'>): string {
  return documentCurrency({ currency: facts.amountCurrency });
}

/**
 * Kwota tak, jak zapisze ją kolumna `expenses.gross_amount` (NUMERIC(14,2)):
 * grosze, połówki od zera, liczone na zapisie dziesiętnym — tym samym, który
 * leci do bazy w JSON-ie. Odcisk karty porównuje się z tym, co odczyta
 * `readState`, więc grosz różnicy to karta „nieaktualna” przy pierwszym
 * kliknięciu.
 *
 * DLACZEGO NIE `roundToCents`: liczy na przybliżeniu binarnym, a 2,135 to
 * binarnie 2,13499…, więc daje 2,13 — Postgres z napisu „2.135” zapisze 2,14.
 * Kwoty z najwyżej dwoma miejscami wychodzą bez zmian (ta sama liczba, ten
 * sam napis w odcisku).
 */
function storedCents(amount: number): number {
  const cents = Math.round(Number(`${Math.abs(amount)}e2`));
  // NaN, nieskończoność i zapis wykładniczy (ułamki poniżej milionowej) nie
  // przechodzą przez `e2` — to i tak zero groszy.
  if (!Number.isFinite(cents)) return 0;
  return Math.sign(amount) * Number(`${cents}e-2`);
}

// ═══════════════════════════════════════════════════════════════
// Budowa propozycji — funkcja czysta
// ═══════════════════════════════════════════════════════════════

export interface BuildExpenseProposalInput {
  tenantId: string;
  expenseId: string;
  /** Zadanie OCR, z którego powstał koszt — po nim baner poznaje swój paragon. */
  ocrJobId?: string;
  facts: OcrFacts;
  history: SellerHistory;
  /** Co agent ustawił sam — potrzebne do cofnięcia. */
  applied: { kpirColumn: string | null; categoryLabel: string | null };
  /**
   * `expenses.is_deductible` zapisanego wydatku. Brak = true dla kwot
   * w złotych, false dla nieprzeliczonych (bez kursu wydatek nie idzie do KPiR).
   */
  deductible?: boolean;
  now?: Date;
}

export function buildExpenseReviewProposal(
  input: BuildExpenseProposalInput,
): CreateProposalInput {
  const now = input.now ?? new Date();
  const currency = amountCurrencyOf(input.facts);
  const withoutRate = currency !== HOME_CURRENCY;

  // Karta powstaje PO zapisie wydatku, więc surowa historia zawiera i jego.
  // Bez wykluczenia sprzedawca nigdy nie byłby „nieznany”, a mediana
  // porównywałaby kwotę z nią samą. Historia podana wprost (bez wierszy) —
  // jak dotąd.
  const history = input.history.entries
    ? historyForCard(
        input.history.entries,
        input.expenseId,
        withoutRate ? null : input.facts.grossAmount,
      )
    : input.history;
  const assessment = assessExpense(input.facts, history);

  const deductible = input.deductible ?? !withoutRate;
  // Ta sama kwota na karcie i w odcisku — taka, jaką zapisała baza.
  const gross = storedCents(input.facts.grossAmount ?? 0);

  const seller = input.facts.sellerName ?? 'Nieznany sprzedawca';
  const amount = formatMoneyPlain(gross, currency);
  const category = input.applied.categoryLabel ?? 'do decyzji';

  const copy = assessment.needsQuestion
    ? renderCopyVariant('expense.review', 'ask', {
        sprzedawca: seller,
        kwota: amount,
        powod: assessment.reason,
      })
    : renderCopyVariant('expense.review', 'done', {
        sprzedawca: seller,
        kwota: amount,
        kategoria: category,
      });

  // Te same klucze i wartości, które `readState` czyta z bazy przy kliknięciu
  // (`lib/flo/fingerprint.ts`) — inaczej „Zgadza się” kończy się „dane się
  // zmieniły”, choć nikt niczego nie ruszał.
  const facts = {
    grossTotal: gross,
    kpirColumn: input.applied.kpirColumn,
    reviewedAt: 0,
    deductible: deductible ? 1 : 0,
  };

  return {
    tenantId: input.tenantId,
    kind: 'expense.review',
    // Jeden koszt = jedna karta, niezależnie od tego, ile razy przeliczymy.
    topicKey: `expense.review:${input.expenseId}`,
    title: copy.title,
    body: copy.body,
    fingerprint: fingerprintOf(facts),
    // Koszt nie przeterminowuje się szybko — klient ma prawo przejrzeć to
    // po powrocie z urlopu.
    expiresAt: new Date(now.getTime() + 30 * 86_400_000),
    priority: assessment.needsQuestion ? 40 : 60,
    payload: {
      expenseId: input.expenseId,
      // Ten sam klucz co w karcie porażki — czyta go `readOcrCard` dla banera.
      ...(input.ocrJobId ? { ocrJobId: input.ocrJobId } : {}),
      facts,
      issues: assessment.issues,
      // Bez kursu nie ma czego potwierdzać: „Zgadza się” oznaczyłoby jako
      // przejrzany koszt, którego kwoty w złotych nikt nie zna. Przycisk
      // prowadzi do formularza wydatku (pierwszy dowód).
      ...(assessment.issues.includes('missing_rate')
        ? { primaryIntent: 'open', primaryLabel: 'Uzupełnij kwotę w złotych' }
        : {}),
      // Kategoryzacja to czynność odwracalna wewnątrz konta — więc ma
      // cofnięcie. Bez tego „odwracalne” byłoby deklaracją, nie własnością.
      undo: assessment.needsQuestion
        ? undefined
        : captureUndo(
            'expenses',
            input.expenseId,
            { kpir_column: null, is_reviewed: false },
            {
              kpir_column: input.applied.kpirColumn,
              is_reviewed: false,
            },
            now,
          ),
    },
    evidence: [
      { label: 'Wydatek', href: `/expenses/${input.expenseId}` },
      { label: 'Wszystkie koszty', href: '/expenses' },
    ],
  };
}

/** Klucz tematu karty „nie odczytałem” — jeden dla zadania OCR. */
export function ocrFailedTopicKey(ocrJobId: string): string {
  return `expense.review:ocr:${ocrJobId}`;
}

/** Karta po nieudanym odczycie — zawsze z drogą wyjścia, nigdy bez. */
export function buildOcrFailedProposal(
  tenantId: string,
  ocrJobId: string,
  now: Date = new Date(),
): CreateProposalInput {
  const copy = renderCopyVariant('expense.review', 'failed', {});

  return {
    tenantId,
    kind: 'expense.review',
    topicKey: ocrFailedTopicKey(ocrJobId),
    title: copy.title,
    body: copy.body,
    fingerprint: fingerprintOf({ ocrJobId }),
    expiresAt: new Date(now.getTime() + 7 * 86_400_000),
    priority: 45,
    payload: {
      // `ocrJobId` i `failed` niesie baner — nie zmieniać kluczy.
      ocrJobId,
      failed: 1,
      // Wydatku jeszcze nie ma, więc domyślne „Zgadza się” zawsze kończyło się
      // „Propozycja bez identyfikatora wydatku”. Wpisu ręcznego kosztu nie ma
      // (plan kompletnej aplikacji, 2.6; formularz to krok 3.8), więc droga
      // wyjścia to ponowne wgranie dokumentu: przycisk prowadzi do listy
      // wydatków, gdzie jest „+ Dodaj wydatek” (pierwszy dowód).
      primaryIntent: 'open',
      primaryLabel: 'Otwórz Wydatki',
    },
    evidence: [{ label: 'Wydatki', href: '/expenses' }],
  };
}

// ═══════════════════════════════════════════════════════════════
// Odczyt historii sprzedawcy
// ═══════════════════════════════════════════════════════════════

interface ExpensesRows {
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
}

/** Strona wydatków po `id` (`readAllById`). */
interface ExpensesPageQuery {
  gt(column: string, value: string): ExpensesPageQuery;
  order(
    column: string,
    options: { ascending: boolean },
  ): {
    limit(count: number): PromiseLike<{
      data: Array<Record<string, unknown> & { id: string }> | null;
      error: { message: string } | null;
    }>;
  };
}

interface ExpensesClient {
  from: (table: 'expenses' | 'ocr_jobs') => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        eq: (column: string, value: string) => ExpensesPageQuery;
      };
      in: (
        column: string,
        values: readonly string[],
      ) => {
        lt: (column: string, value: string) => Promise<ExpensesRows>;
      };
    };
    update: (patch: Record<string, unknown>) => {
      eq(column: string, value: string): {
        eq(column: string, value: string): {
          select(columns: string): {
            maybeSingle(): Promise<{
              data: { id: string } | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
}

/**
 * Historia sprzedawcy z wierszy — funkcja czysta.
 *
 * `count` to liczba INNYCH dokumentów (każdy, nawet bez kwoty w złotych,
 * czyni sprzedawcę znanym). Mediana tylko z kwot w złotych; `medianBasis`
 * mówi, ile ich było, bo to od nich zależy, czy mediana cokolwiek znaczy.
 */
export function sellerHistoryFrom(
  entries: readonly SellerHistoryEntry[],
  excludeExpenseId?: string,
): SellerHistory {
  const others =
    excludeExpenseId === undefined
      ? entries
      : entries.filter((entry) => entry.expenseId !== excludeExpenseId);

  const amounts = medianAmounts(others.map((entry) => entry.grossPln));

  return {
    count: others.length,
    medianGross: median(amounts),
    medianBasis: amounts.length,
    entries: others,
  };
}

/**
 * Historia, z którą karta porównuje bieżący wydatek: bez niego samego. Gdy
 * jednak do progu mediany brakuje JEDNEJ kwoty, bieżąca ją uzupełnia — tak
 * liczyła karta przed wykluczeniem, więc trzeci dokument u sprzedawcy nie
 * traci sita rzędu wielkości. Mediana z trzech i tak wskazuje typową kwotę,
 * gdy sprawdzana odstaje (312, 315 i 31 240 → 315).
 *
 * `currentPln` = kwota bieżącego wydatku w złotych; `null`, gdy jest w walucie
 * bez kursu (wtedy rzędu wielkości i tak nie oceniamy).
 */
function historyForCard(
  entries: readonly SellerHistoryEntry[],
  expenseId: string,
  currentPln: number | null,
): SellerHistory {
  const history = sellerHistoryFrom(entries, expenseId);
  if (history.medianBasis !== HISTORY_MIN - 1) return history;

  // Bez ważnej bieżącej kwoty zostają te same kwoty — mediana bez zmian,
  // a próg dalej niespełniony.
  const amounts = medianAmounts([
    ...(history.entries ?? []).map((entry) => entry.grossPln),
    currentPln,
  ]);

  return { ...history, medianGross: median(amounts), medianBasis: amounts.length };
}

/** Kwoty, które mogą wejść do mediany: dodatnie, w złotych, rosnąco. */
function medianAmounts(amounts: ReadonlyArray<number | null>): number[] {
  return amounts
    .filter((n): n is number => n !== null && Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

/**
 * Wszystkie wydatki tego sprzedawcy — RAZEM z właśnie zapisanym; wyklucza go
 * dopiero karta (`buildExpenseReviewProposal`), bo tylko ona zna jego id.
 *
 * Waluta i kurs pochodzą ze śladu OCR (`ocr_extracted_data`): wiersz w walucie
 * obcej bez kursu ma w `gross_amount` kwotę w tej walucie, nie w złotych.
 * Wiersze bez śladu waluty (wpisane ręcznie, z KSeF, sprzed obsługi walut)
 * liczymy jak dotąd — w złotych; tak samo wiersze włączone do KPiR
 * (`is_deductible`), bo tam kwota jest w złotych niezależnie od śladu.
 */
export async function readSellerHistory(
  tenantId: string,
  sellerName: string | null,
  client: ExpensesClient = createAdminClient() as unknown as ExpensesClient,
): Promise<SellerHistory> {
  if (!sellerName) return sellerHistoryFrom([]);

  // Sesja 29 planu skalowania: stronami po `id`. Jedno zapytanie oddawało
  // najwyżej 1000 wierszy (`PGRST_DB_MAX_ROWS`) bez błędu, więc u dostawcy
  // z ponad 1000 dokumentami liczba i mediana szły z przypadkowego kawałka.
  // Koniec na pustej stronie, bez liczby z pierwszej: paragon dopisany
  // w trakcie odczytu (zdjęcia wgrane paczką) nie wywraca karty.
  const rows = await readAllById('historia sprzedawcy', (afterId, limit) => {
    let query = client
      .from('expenses')
      .select(
        'id, gross_amount, is_deductible, currency:ocr_extracted_data->>currency, fx:ocr_extracted_data->fx',
      )
      .eq('tenant_id', tenantId)
      .eq('seller_name', sellerName);
    if (afterId) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(limit);
  });

  return sellerHistoryFrom(rows.map(historyEntryFromRow));
}

function historyEntryFromRow(row: Record<string, unknown>): SellerHistoryEntry {
  const currency = documentCurrency({
    currency: typeof row.currency === 'string' ? row.currency : null,
  });
  // Kurs zapisany przy koszcie = kwota w `gross_amount` jest już w złotych.
  const converted = typeof row.fx === 'object' && row.fx !== null;
  // Koszt w KPiR liczy się w złotych. Wydatek bez kursu zapisujemy poza
  // KPiR, więc włączony to taki, który ktoś poprawił ręcznie na złotówki —
  // ślad OCR dalej mówi „EUR” i nie ma kursu, ale kwota jest już w złotych.
  const inKpir = row.is_deductible === true;
  const gross = Number(row.gross_amount ?? 0);

  return {
    expenseId: String(row.id),
    grossPln:
      (currency === HOME_CURRENCY || converted || inKpir) && Number.isFinite(gross)
        ? gross
        : null,
  };
}

export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// ═══════════════════════════════════════════════════════════════
// Wykonawca
// ═══════════════════════════════════════════════════════════════

/**
 * „Zgadza się” — klient potwierdza to, co agent przypisał.
 *
 * Czynność wewnętrzna i odwracalna, więc nie wymaga niczego poza żetonem,
 * który wykonawca sprawdził przed wywołaniem tego kodu.
 */
registerFloHandler('expense.review', async (ctx) => {
  const expenseId = ctx.proposal.payload?.expenseId;
  if (typeof expenseId !== 'string') {
    throw new Error('Propozycja bez identyfikatora wydatku');
  }

  const client = createAdminClient();
  const { data: expense, error: readError } = await client
    .from('expenses')
    .select('source, ksef_invoice_id')
    .eq('id', expenseId)
    .eq('tenant_id', ctx.proposal.tenant_id)
    .maybeSingle();

  if (readError) throw new Error('Nie można sprawdzić źródła wydatku');
  if (!expense) throw new Error('Wydatek nie należy do organizacji albo już nie istnieje');
  if (expense.source === 'ksef_inbox' || expense.ksef_invoice_id !== null) {
    throw new Error('Koszt powiązany z KSeF wymaga przeglądu w formularzu wydatku');
  }

  const { data, error } = await client
    .from('expenses')
    .update({ is_reviewed: true })
    .eq('id', expenseId)
    .eq('tenant_id', ctx.proposal.tenant_id)
    // Warunki należą do samego UPDATE, więc zmiana źródła między odczytem a
    // zapisem nie pozwoli FLO potwierdzić kosztu KSeF przez service_role.
    .neq('source', 'ksef_inbox')
    .is('ksef_invoice_id', null)
    .select('id')
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error('Wydatek zmienił się lub wymaga przeglądu w formularzu. Odśwież kartę.');

  // W-03 (plan FLO 2, K1.8): drugi raz ten sam sprzedawca → pytanie o regułę.
  // Tu, a nie w pulsie: reguła ma się brać z decyzji człowieka, którą właśnie
  // podjął, i pytanie pada, gdy ma sprawę w głowie.
  //
  // W OSOBNYM `try`, bo to jest dodatek do czynności, o którą prosił klient.
  // Gdyby pytanie o regułę wywróciło wykonanie, człowiek zobaczyłby „nie udało
  // mi się tego dokończyć" przy koszcie, który JEST już potwierdzony — i tę
  // samą kartę do kliknięcia jeszcze raz.
  const ruleOutcome = await proposeRuleAfterReview(
    ctx.proposal.tenant_id,
    expenseId,
    new Date(),
    floDb(),
    productionRuleLearningSources(),
  ).catch((e: unknown) => {
    Sentry.captureException(e, {
      tags: {
        job: 'flo.expense.review',
        kind: 'expense.rule',
        tenant_id: ctx.proposal.tenant_id,
      },
    });
    console.error(
      `[flo] W-03 nie zapytało o regułę dla kosztu ${expenseId}: ${
        e instanceof Error ? e.message : 'nieznany błąd'
      }`,
    );
    return 'failed' as const;
  });

  return {
    summary: 'koszt potwierdzony przez klienta',
    details: { expenseId, rule: ruleOutcome },
  };
});

// ═══════════════════════════════════════════════════════════════
// Strażnik zawieszonych odczytów
// ═══════════════════════════════════════════════════════════════

/**
 * Zamienia porzucone zadania OCR w karty z drogą wyjścia.
 *
 * DLACZEGO NIE OZNACZAMY ZADANIA JAKO NIEUDANEGO: tak samo jak istniejący
 * strażnik zadań, nie mutujemy cudzego stanu. Zadanie mogło być tylko wolne,
 * a przedwczesne oznaczenie go jako błąd zatruwa kolejkę. Tworzymy kartę;
 * jeśli odczyt jednak dojdzie, job zamknie kartę porażki tego zadania
 * (`closeFailedCard` w `process-ocr.ts`) — karta kosztu ma INNY klucz tematu.
 *
 * WOŁANE Z DWÓCH MIEJSC: z pulsu agenta (raz dziennie, jako siatka
 * bezpieczeństwa) i ze strażnika zadań co piętnaście minut, bo to on ma
 * właściwą częstotliwość. Podwójne wywołanie jest nieszkodliwe — klucz
 * tematu gwarantuje jedną kartę na jedno zadanie.
 */
export async function findStuckOcrJobs(
  tenantScopedNow: Date,
  client: ExpensesClient = createAdminClient() as unknown as ExpensesClient,
): Promise<Array<{ id: string; tenantId: string }>> {
  const cutoff = new Date(
    tenantScopedNow.getTime() - OCR_STUCK_AFTER_MS,
  ).toISOString();

  const { data, error } = await client
    .from('ocr_jobs')
    .select('id, tenant_id, status, created_at')
    .in('status', ['pending', 'processing'])
    .lt('created_at', cutoff);

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: String(row.id),
    tenantId: String(row.tenant_id),
  }));
}
