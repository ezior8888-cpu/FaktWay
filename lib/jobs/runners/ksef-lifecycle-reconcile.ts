import { randomUUID } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';

import { todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  buildKsefRequeueEvent,
  KSEF_RESEND_SOURCE_COLUMNS,
  type KsefRequeueRefusal,
  type KsefRequeueSourceRow,
} from '@/lib/invoices/ksef-requeue-event';
import { isOpenCorrectionConflict, ksefSendTransactionStep } from '@/lib/invoices/ksef-send-step';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import type { JobContext } from '@/lib/jobs/registry';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { sendableSpecialKinds } from '@/lib/ksef/kind-holds';
import { AUTO_REQUEUE_CODES, SEND_ERROR_CODES } from '@/lib/ksef/send-error-classes';
import { isKsefSubmissionPaused } from '@/lib/ksef/submission-holds';
import { applyCursorFilter, type CursorPayload } from '@/lib/pagination/cursor';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Cron `cron.ksef-lifecycle-reconcile` (co 15 min) — automat cyklu życia
 * faktury (PR 4b; docs/architecture/cykl-zycia-faktury-ksef.md, sekcja 5):
 *
 *   I1  `queued` ponad 15 min bez zlecenia w pg-boss → `release_ksef_enqueue`
 *       (powrót do szkicu, gdy nie ma dowodu kontaktu z KSeF); gdy dowód jest,
 *       `failed ENQUEUE_LOST` (klasa reconcile — operator).
 *   I6  `failed` z kodem klasy transient z listy `AUTO_REQUEUE_CODES` (lustro
 *       `auto_requeue`: awaria KSeF, limit, sesja, nasza baza) →
 *       `requeue_ksef_send` nie częściej niż co godzinę; po 24 automatycznych
 *       ponowieniach w ciągu doby `TRANSIENT_EXHAUSTED` (decyzja D1) — dalej
 *       klient albo operator.
 *   I7  `failed KSEF_PAUSED` po zdjęciu wyłącznika operatora → ponowienie.
 *       KOR_HOLD i ROZ_HOLD zostają operatorowi (zdejmuje je C4).
 *   I5  (A3) otwarty wpis `sent` albo zamiar `intent` starszy niż 48 h przy
 *       fakturze `failed`/`rejected` → „tylko uzgodnij” (`requeue_ksef_send`
 *       z `p_reconcile_only`): runner pyta KSeF o tamtą wysyłkę i NIGDY nie
 *       wysyła od nowa. Najwyżej raz na dobę na fakturę; po trzech próbach
 *       w tygodniu cron przestaje i alarmuje — faktura czeka na operatora.
 *       Wynik uzgodnienia: `accepted`, `rejected` albo `NOT_IN_KSEF`
 *       (A2b — klient wysyła ponownie albo wraca do szkicu).
 *   I5D (00148, faktura czeka na decyzję klienta) — cron jej nie uzgadnia.
 *
 * Dokumenty specjalne (A4b PR2a) — zdarzenie z kopii na wierszu
 * (`ksef-requeue-event.ts`): I6/I7 ponawiają KOR/ZAL z zapisanymi danymi
 * tylko w dniu wystawienia i tylko rodzaj niewstrzymany w tym środowisku
 * (KOR nie na PROD, ROZ nigdy — C4; decyzja Bartosza 06.10.2026 b).
 * Ponowienie, które dojdzie do KSeF po północy, worker kończy kodem
 * `ISSUE_DATE_PASSED` (00147). I5 uzgadnia KOR/ZAL z danymi bez względu na
 * datę (uzgodnienie nie wysyła); KOR na PROD i ROZ — tylko alarm.
 *
 * Każde ponowienie to RPC w jednej transakcji ze zleceniem pg-boss (jak
 * kolejkowanie z akcji klienta), z aktorem NULL — po tym cron rozpoznaje
 * swoje ponowienia w `audit_logs` i liczy je do limitu. Przy włączonym
 * hamulcu (albo gdy nie da się go odczytać) cron niczego nie ponawia;
 * I1 obsługuje zawsze, bo to porządkowanie, nie wysyłka.
 *
 * Pozostałe naruszenia (I2–I4, I9 oraz I5 przy fakturze w innym stanie)
 * alarmuje monitor alarmów (`checkKsefLifecycleViolations`) — tam nie ma
 * bezpiecznej akcji automatu; cron I5 w innym stanie tylko liczy i loguje
 * (`i5Other`).
 *
 * Ślad decyzji (A5, luka #2): I5 po limicie prób, I5 poza failed/rejected
 * i odmowa budowy zlecenia nie zmieniają wiersza faktury, więc w bazie nie
 * zostaje po nich nic. Log nazywa fakturę (`invoiceId`, inwariant, powód)
 * w każdym przebiegu, który do niej dochodzi, a zbiorczy Sentry niesie obok
 * pełnych liczników do `LIFECYCLE_SENTRY_IDS_MAX` identyfikatorów na rodzaj
 * (`<licznik>Ids`). ENQUEUE_LOST i TRANSIENT_EXHAUSTED zostawiają kod na
 * wierszu (audyt tych przejść: luka #1).
 *
 * Paczka (A5, zagłodzenie): `LIFECYCLE_BATCH` liczy faktury, przy których
 * automat działa, nie odczytane wiersze. Faktura, której nie ruszy (odmowa
 * budowy zlecenia, I5 poza failed/rejected, po limicie albo odroczone), nie
 * zmienia wiersza i wraca w każdym przebiegu na to samo miejsce — przy
 * limicie odczytu sto takich zajęłoby paczkę na zawsze. Odczyt idzie więc
 * dalej stronami (I6/I7 kursorem po `updated_at, id`, I5 po 100
 * identyfikatorów), najwyżej `LIFECYCLE_SCAN_MAX_PAGES` stron na zapytanie;
 * bezpiecznik ostrzega i liczy `scanCapped`.
 */

/** Nie częściej niż raz na godzinę dla jednej faktury. */
export const LIFECYCLE_REQUEUE_MIN_AGE_MS = 60 * 60 * 1000;
/** 24 automatyczne ponowienia ≈ doba (D1). */
export const LIFECYCLE_REQUEUE_MAX = 24;
/** Okno zliczania ponowień w audycie — doba z zapasem na przesunięcia przebiegów. */
export const LIFECYCLE_REQUEUE_WINDOW_MS = 25 * 60 * 60 * 1000;
/**
 * Paczka na przebieg (na zapytanie) — faktury, przy których automat działa;
 * przy zaległości kolejne przebiegi dobiorą resztę.
 */
export const LIFECYCLE_BATCH = 100;
/**
 * Bezpiecznik odczytu: najwyżej tyle stron po `LIFECYCLE_BATCH` wierszy na jedno
 * zapytanie w przebiegu. Gdy zadziała, za odmówionymi fakturami mogą czekać
 * poprawne — automat ich nie zobaczy, dopóki odmówionych nie ubędzie.
 */
export const LIFECYCLE_SCAN_MAX_PAGES = 10;
/** I5 (A3): „tylko uzgodnij” z crona najwyżej raz na dobę na fakturę… */
export const LIFECYCLE_RECONCILE_MIN_GAP_MS = 24 * 60 * 60 * 1000;
/** …i najwyżej trzy razy w tygodniu — potem operator. */
export const LIFECYCLE_RECONCILE_MAX = 3;
export const LIFECYCLE_RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Identyfikatorów jednego rodzaju w zbiorczym Sentry — pełna liczba jest obok, w liczniku. */
export const LIFECYCLE_SENTRY_IDS_MAX = 20;
/** Stany, z których `requeue_ksef_send` przyjmuje tryb uzgodnienia (00131). */
const RECONCILABLE_STATUSES: readonly string[] = ['failed', 'rejected'];

export const TRANSIENT_EXHAUSTED_MESSAGE =
  'Automatyczne ponowienia przez 24 godziny nie powiodły się. Wyślij fakturę ponownie ręcznie albo wróć do szkicu.';
export const ENQUEUE_LOST_MESSAGE =
  'Zlecenie wysyłki zaginęło, a faktura ma ślad kontaktu z KSeF — wymaga uzgodnienia przez operatora.';
export const I1_RELEASE_REASON = 'I1: queued ponad 15 min bez zlecenia w pg-boss';
const SCAN_CAPPED_WARNING =
  'Cykl życia: bezpiecznik odczytu — strony pełne faktur, których automat nie ruszy; poprawne za nimi nie są ponawiane';

export interface LifecycleReconcileReport {
  /** `null` = nie udało się odczytać hamulca (ponowienia pominięte). */
  paused: boolean | null;
  i1Released: number;
  i1Lost: number;
  requeued: number;
  exhausted: number;
  resumedAfterPause: number;
  /** Brak danych do odtworzenia zdarzenia: zwykła bez pozycji albo stary dokument specjalny. */
  skippedNoData: number;
  /** Rodzaj wstrzymany w tym środowisku (w praktyce I5: KOR na PROD, ROZ). */
  skippedHeld: number;
  /** Data wystawienia dokumentu specjalnego minęła między odczytem a zleceniem (północ). */
  skippedIssueDate: number;
  /** Brak NIP-u sprzedawcy (ani w firmie, ani w `fa3_data`) — błąd danych. */
  skippedNoNip: number;
  /** Odrzucona korekta czeka na inną korektę tej samej faktury pierwotnej (00135). */
  skippedConflict: number;
  /** I5: zlecone „tylko uzgodnij”. */
  i5Reconciled: number;
  /** I5: ostatnia próba z crona młodsza niż doba — czekamy. */
  i5Deferred: number;
  /** I5: trzy próby w tygodniu bez skutku — operator. */
  i5NeedsOperator: number;
  /** I5 przy fakturze poza failed/rejected — tylko alarm. */
  i5Other: number;
  /** Zapytania, w których bezpiecznik odczytu przerwał szukanie przed zapełnieniem paczki. */
  scanCapped: number;
  errors: number;
}

type ReportCounter = Exclude<keyof LifecycleReconcileReport, 'paused'>;
/** Liczniki decyzji bez zmiany wiersza faktury — z identyfikatorami w Sentry. */
type IdCounter = Extract<ReportCounter,
  'i5NeedsOperator' | 'i5Other' | 'skippedNoData' | 'skippedNoNip' | 'skippedHeld' | 'skippedIssueDate' | 'skippedConflict'>;
/**
 * Liczniki, które wysyłają zbiorczy Sentry (bez zmian od A3). Stany trwałe
 * bez wyjścia automatu (`i5Other`, `skippedNoData`, `skippedNoNip`) go nie
 * wysyłają: zdarzenie nie ma deduplikacji, więc jedna taka faktura dawałaby
 * 96 zdarzeń na dobę we wspólnej kwocie Sentry (osobne ustalenie). Ich
 * identyfikatory są w logu i w `extra`, gdy zdarzenie idzie z innego powodu.
 */
const OPERATOR_COUNTERS = ['exhausted', 'i1Lost', 'i5NeedsOperator'] as const satisfies readonly ReportCounter[];

interface ViolationRow {
  invariant: string;
  invoice_id: string;
  tenant_id: string;
}

type CandidateRow = KsefRequeueSourceRow & { last_error_code: string | null; updated_at: string | null; ksef_status?: string | null };
/** Kolumny źródła ponowienia + to, czego potrzebuje cron (jeden zestaw dla I5/I6/I7). */
const CANDIDATE_COLUMNS = `${KSEF_RESEND_SOURCE_COLUMNS}, id, tenant_id, last_error_code, updated_at, tenants(nip)` as const;
const STALE_COLUMNS = `${CANDIDATE_COLUMNS}, ksef_status` as const;
type RequeueOutcome = 'sent' | 'conflict' | KsefRequeueRefusal;
/** Licznik pominięcia — nowy powód odmowy buildera nie skompiluje się bez swojego licznika. */
const SKIP_COUNTER: Record<Exclude<RequeueOutcome, 'sent'>, IdCounter> = {
  'missing-special-data': 'skippedNoData',
  incomplete: 'skippedNoData',
  'kind-held': 'skippedHeld',
  'issue-date': 'skippedIssueDate',
  conflict: 'skippedConflict',
  'no-nip': 'skippedNoNip',
};

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-a.ts (kolejka cron.ksef-lifecycle-reconcile).
 */
export async function runKsefLifecycleReconcile({ step, logger }: JobContext): Promise<LifecycleReconcileReport> {
  const env = requireConfiguredKsefEnvironment();
  const supabase = createAdminClient();
  const report: LifecycleReconcileReport = {
    paused: null, i1Released: 0, i1Lost: 0, requeued: 0, exhausted: 0, resumedAfterPause: 0,
    skippedNoData: 0, skippedHeld: 0, skippedIssueDate: 0, skippedNoNip: 0, skippedConflict: 0,
    i5Reconciled: 0, i5Deferred: 0, i5NeedsOperator: 0, i5Other: 0, scanCapped: 0, errors: 0,
  };
  /** Identyfikatory do zbiorczego Sentry: tylko niepuste rodzaje, najwyżej LIFECYCLE_SENTRY_IDS_MAX. */
  const invoiceIds: Partial<Record<IdCounter, string[]>> = {};
  const count = (counter: IdCounter, invoiceId: string) => {
    report[counter] += 1;
    const ids = (invoiceIds[counter] ??= []);
    if (ids.length < LIFECYCLE_SENTRY_IDS_MAX) ids.push(invoiceId);
  };
  const countSkip = (outcome: Exclude<RequeueOutcome, 'sent'>, invoiceId: string) => count(SKIP_COUNTER[outcome], invoiceId);
  /** Faktury odczytane przez I6/I7 w tym przebiegu (zlecone i odmówione) — I5 ich nie bierze. */
  const scanned = new Set<string>();
  /**
   * Faktury do ponowienia: zwykłe i dokumenty specjalne osobnymi zapytaniami,
   * żeby specjalne pominięte w tym przebiegu nie zajmowały paczki zwykłych.
   * Specjalne tylko z dzisiejszą datą wystawienia i rodzaju niewstrzymanego.
   * Odmówione przez builder liczymy tu i nie zwracamy (A5, zagłodzenie).
   */
  const candidates = async (
    narrow: (query: ReturnType<typeof baseCandidates>) => ReturnType<typeof baseCandidates>,
    errorText: string,
    invariant: 'I6' | 'I7',
  ): Promise<CandidateRow[]> => {
    const regular = await collect(() => narrow(baseCandidates()).eq('invoice_kind', 'regular'), { invariant, kind: 'regular' }, errorText);
    const kinds = sendableSpecialKinds(env);
    if (kinds.length === 0) return regular;
    const today = todayInWarsaw();
    const special = await collect(
      () => narrow(baseCandidates()).in('invoice_kind', kinds).eq('issue_date', today), { invariant, kind: 'special' }, errorText);
    return [...regular, ...special];
  };
  /**
   * Do `LIFECYCLE_BATCH` faktur, które automat może zlecić — stronami po
   * (updated_at, id), kursorem, nie przesunięciem: zlecone wypadają ze zbioru
   * w trakcie, odmówione zostają. Najwyżej `LIFECYCLE_SCAN_MAX_PAGES` stron.
   */
  async function collect(
    query: () => ReturnType<typeof baseCandidates>,
    scan: { invariant: 'I6' | 'I7'; kind: 'regular' | 'special' },
    errorText: string,
  ): Promise<CandidateRow[]> {
    const picked: CandidateRow[] = [];
    let cursor: CursorPayload | null = null;
    for (let page = 1; page <= LIFECYCLE_SCAN_MAX_PAGES; page++) {
      const { data, error } = await applyCursorFilter(query(), 'updated_at', cursor, 'asc')
        .order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(LIFECYCLE_BATCH);
      if (error) throw new Error(`${errorText}: ${error.message}`);
      const rows = (data ?? []) as unknown as CandidateRow[];
      for (const row of rows) {
        // Wiersz zmieniony w trakcie (nowe updated_at) wraca na dalszej stronie — raz na przebieg.
        if (scanned.has(row.id)) continue;
        scanned.add(row.id);
        const refused = refusal(row, { invariant: scan.invariant, reconcileOnly: false });
        if (refused) {
          countSkip(refused, row.id);
          continue;
        }
        picked.push(row);
        if (picked.length === LIFECYCLE_BATCH) return picked;
      }
      if (rows.length < LIFECYCLE_BATCH) return picked;
      const last = rows[rows.length - 1]!;
      if (typeof last.updated_at !== 'string') {
        // NULLS LAST: dalej są już tylko wiersze bez daty — kursor po dacie ich nie obejmie.
        logger.warn('Cykl życia: faktury bez updated_at — odczyt przerwany na nich', { ...scan, pages: page, collected: picked.length });
        return picked;
      }
      const next: CursorPayload = { sortValue: last.updated_at, id: last.id };
      if (cursor && next.sortValue === cursor.sortValue && next.id === cursor.id) {
        throw new Error(`${errorText}: stronicowanie nie posuwa się naprzód`);
      }
      cursor = next;
    }
    report.scanCapped += 1;
    logger.warn(SCAN_CAPPED_WARNING, { ...scan, pages: LIFECYCLE_SCAN_MAX_PAGES, collected: picked.length });
    return picked;
  }
  function baseCandidates() {
    return supabase
      .from('invoices')
      .select(CANDIDATE_COLUMNS)
      .eq('direction', 'outgoing')
      .eq('ksef_status', 'failed');
  }

  // Hamulec operatora: odczyt autorytatywny, awaria = brak ponowień (fail-closed).
  report.paused = await step.run('read-pause-flag', async (): Promise<boolean | null> => {
    try {
      return await isKsefSubmissionPaused();
    } catch {
      return null;
    }
  });

  // ── I1: queued bez zlecenia ───────────────────────────────────────
  const violations = await step.run('read-violations', async (): Promise<ViolationRow[]> => {
    const { data, error } = await supabase.rpc('ksef_lifecycle_violations');
    if (error) throw new Error(`ksef_lifecycle_violations: ${error.message}`);
    return (data ?? []) as ViolationRow[];
  });
  for (const v of violations.filter((row) => row.invariant === 'I1').slice(0, LIFECYCLE_BATCH)) {
    try {
      const released = await step.run(`i1-release-${v.invoice_id}`, async (): Promise<boolean> => {
        const { data, error } = await supabase.rpc('release_ksef_enqueue', {
          p_invoice_id: v.invoice_id,
          p_tenant_id: v.tenant_id,
          p_reason: I1_RELEASE_REASON,
        });
        if (error) throw new Error(`release_ksef_enqueue: ${error.message}`);
        return data === true;
      });
      if (released) {
        report.i1Released += 1;
        continue;
      }
      // Dowód kontaktu z KSeF jest, a zlecenia nie ma — nie wiadomo, co KSeF dostał.
      await step.run(`i1-lost-${v.invoice_id}`, async () => {
        const { error } = await supabase
          .from('invoices')
          .update({
            ksef_status: 'failed',
            last_error_code: SEND_ERROR_CODES.ENQUEUE_LOST,
            last_error: ENQUEUE_LOST_MESSAGE,
            ksef_send_owner: null,
          })
          .eq('id', v.invoice_id)
          .eq('tenant_id', v.tenant_id)
          .eq('ksef_status', 'queued');
        if (error) throw new Error(`ENQUEUE_LOST: ${error.message}`);
      });
      report.i1Lost += 1;
    } catch (e) {
      report.errors += 1;
      logger.error('Cykl życia: I1 nieobsłużone', { invoiceId: v.invoice_id, error: e instanceof Error ? e.message : String(e) });
      Sentry.captureException(e, { tags: { job: 'ksef-lifecycle-reconcile', invariant: 'I1' }, extra: { invoiceId: v.invoice_id } });
    }
  }

  if (report.paused !== false) {
    logger.warn(report.paused === null
      ? 'Cykl życia: nie można odczytać hamulca — ponowienia pominięte'
      : 'Cykl życia: wysyłki wstrzymane wyłącznikiem — ponowienia pominięte');
  } else {
    // ── I6: automatyczne ponowienie klasy transient ─────────────────
    const cutoffIso = new Date(Date.now() - LIFECYCLE_REQUEUE_MIN_AGE_MS).toISOString();
    const transient = await step.run('find-transient', (): Promise<CandidateRow[]> => candidates(
      (query) => query.in('last_error_code', [...AUTO_REQUEUE_CODES]).lt('updated_at', cutoffIso),
      'Cykl życia: nie można odczytać faktur do ponowienia',
      'I6',
    ));

    const autoCounts = transient.length === 0
      ? new Map<string, number>()
      : await step.run('count-auto-requeues', async (): Promise<Map<string, number>> => {
        const sinceIso = new Date(Date.now() - LIFECYCLE_REQUEUE_WINDOW_MS).toISOString();
        const ids = transient.map((row) => row.id);
        const counts = new Map<string, number>();
        // Paczkami: zwykłe + specjalne to do 200 identyfikatorów — za długi adres dla jednego zapytania.
        for (let i = 0; i < ids.length; i += LIFECYCLE_BATCH) {
          const { data, error } = await supabase
            .from('audit_logs')
            .select('entity_id')
            .eq('action', 'invoice.send_requeued')
            .is('user_id', null)
            .in('entity_id', ids.slice(i, i + LIFECYCLE_BATCH))
            .gte('created_at', sinceIso);
          if (error) throw new Error(`Cykl życia: nie można policzyć ponowień: ${error.message}`);
          for (const row of (data ?? []) as Array<{ entity_id: string | null }>) {
            if (row.entity_id) counts.set(row.entity_id, (counts.get(row.entity_id) ?? 0) + 1);
          }
        }
        return counts;
      });

    for (const row of transient) {
      try {
        if ((autoCounts.get(row.id) ?? 0) >= LIFECYCLE_REQUEUE_MAX) {
          await step.run(`exhaust-${row.id}`, async () => {
            const { error } = await supabase
              .from('invoices')
              .update({
                last_error_code: SEND_ERROR_CODES.TRANSIENT_EXHAUSTED,
                last_error: TRANSIENT_EXHAUSTED_MESSAGE,
              })
              .eq('id', row.id)
              .eq('tenant_id', row.tenant_id)
              .eq('ksef_status', 'failed')
              .eq('last_error_code', row.last_error_code ?? '');
            if (error) throw new Error(`TRANSIENT_EXHAUSTED: ${error.message}`);
          });
          report.exhausted += 1;
          continue;
        }
        const outcome = await step.run(`requeue-${row.id}`, () => requeue(row, { invariant: 'I6' }));
        if (outcome === 'sent') report.requeued += 1;
        else countSkip(outcome, row.id);
      } catch (e) {
        report.errors += 1;
        logger.error('Cykl życia: ponowienie nieudane', { invoiceId: row.id, code: row.last_error_code, error: e instanceof Error ? e.message : String(e) });
        Sentry.captureException(e, { tags: { job: 'ksef-lifecycle-reconcile', invariant: 'I6' }, extra: { invoiceId: row.id, code: row.last_error_code } });
      }
    }

    // ── I7: wznowienie po zdjęciu hamulca operatora ─────────────────
    const held = await step.run('find-paused', (): Promise<CandidateRow[]> => candidates(
      (query) => query.eq('last_error_code', SEND_ERROR_CODES.KSEF_PAUSED),
      'Cykl życia: nie można odczytać faktur po hamulcu',
      'I7',
    ));
    for (const row of held) {
      try {
        const outcome = await step.run(`resume-${row.id}`, () => requeue(row, { invariant: 'I7' }));
        if (outcome === 'sent') report.resumedAfterPause += 1;
        else countSkip(outcome, row.id);
      } catch (e) {
        report.errors += 1;
        logger.error('Cykl życia: wznowienie po hamulcu nieudane', { invoiceId: row.id, error: e instanceof Error ? e.message : String(e) });
        Sentry.captureException(e, { tags: { job: 'ksef-lifecycle-reconcile', invariant: 'I7' }, extra: { invoiceId: row.id } });
      }
    }

    // ── I5: zalegający wpis sent / zamiar intent → „tylko uzgodnij” (A3) ──
    // Faktury odczytane przez I6/I7 tego przebiegu pomijamy: ponowione i tak
    // zaczynają od uzgodnienia (A2), a pominięte (brak danych, NIP) I5 pominąłby
    // z tego samego powodu — liczymy je raz. KOR/ZAL z I6/I7 mają dzisiejszą
    // datę, więc nie mają wpisu starszego niż 48 h.
    // Paczka liczy uzgodnienia (A5): stan, limit prób, odroczenie i odmowę
    // sprawdzamy stronami po 100 identyfikatorów, zanim faktura zajmie miejsce.
    const staleIds = [...new Set(violations.filter((v) => v.invariant === 'I5').map((v) => v.invoice_id))]
      .filter((id) => !scanned.has(id));
    const recentIso = new Date(Date.now() - LIFECYCLE_RECONCILE_MIN_GAP_MS).toISOString();
    const toReconcile: CandidateRow[] = [];
    for (let offset = 0; offset < staleIds.length && toReconcile.length < LIFECYCLE_BATCH; offset += LIFECYCLE_BATCH) {
      const page = offset / LIFECYCLE_BATCH + 1;
      if (page > LIFECYCLE_SCAN_MAX_PAGES) {
        report.scanCapped += 1;
        logger.warn(SCAN_CAPPED_WARNING, { invariant: 'I5', pages: LIFECYCLE_SCAN_MAX_PAGES, collected: toReconcile.length });
        break;
      }
      const ids = staleIds.slice(offset, offset + LIFECYCLE_BATCH);
      const stale = await step.run(`find-stale-submissions-${page}`, async (): Promise<CandidateRow[]> => {
        const { data, error } = await supabase
          .from('invoices')
          .select(STALE_COLUMNS)
          .eq('direction', 'outgoing')
          .in('id', ids);
        if (error) throw new Error(`Cykl życia: nie można odczytać faktur z zalegającym wpisem: ${error.message}`);
        return (data ?? []) as unknown as CandidateRow[];
      });
      const reconcilable: CandidateRow[] = [];
      for (const row of stale) {
        if (RECONCILABLE_STATUSES.includes(row.ksef_status ?? '')) {
          reconcilable.push(row);
          continue;
        }
        count('i5Other', row.id);
        logger.warn('Cykl życia: I5 przy fakturze poza failed/rejected — automat jej nie uzgadnia, czeka na operatora', {
          invoiceId: row.id, invariant: 'I5', status: row.ksef_status ?? null,
        });
      }

      const reconcileAttempts = reconcilable.length === 0
        ? new Map<string, string[]>()
        : await step.run(`count-auto-reconciles-${page}`, async (): Promise<Map<string, string[]>> => {
          const sinceIso = new Date(Date.now() - LIFECYCLE_RECONCILE_WINDOW_MS).toISOString();
          const { data, error } = await supabase
            .from('audit_logs')
            .select('entity_id, created_at')
            .eq('action', 'invoice.send_requeued')
            .is('user_id', null)
            .eq('details_json->>reconcile_only', 'true')
            .in('entity_id', reconcilable.map((row) => row.id))
            .gte('created_at', sinceIso);
          if (error) throw new Error(`Cykl życia: nie można policzyć uzgodnień: ${error.message}`);
          const attempts = new Map<string, string[]>();
          for (const row of (data ?? []) as Array<{ entity_id: string | null; created_at: string }>) {
            if (row.entity_id) attempts.set(row.entity_id, [...(attempts.get(row.entity_id) ?? []), row.created_at]);
          }
          return attempts;
        });

      for (const row of reconcilable) {
        const attempts = reconcileAttempts.get(row.id) ?? [];
        if (attempts.length >= LIFECYCLE_RECONCILE_MAX) {
          count('i5NeedsOperator', row.id);
          logger.warn('Cykl życia: I5 — limit uzgodnień z crona w tygodniu wyczerpany, faktura czeka na operatora', {
            invoiceId: row.id, invariant: 'I5', attempts: attempts.length, lastAttemptAt: attempts.reduce((a, b) => (b > a ? b : a)),
          });
          continue;
        }
        if (attempts.some((at) => at >= recentIso)) {
          report.i5Deferred += 1;
          continue;
        }
        const refused = refusal(row, { invariant: 'I5', reconcileOnly: true });
        if (refused) {
          countSkip(refused, row.id);
          continue;
        }
        if (toReconcile.length < LIFECYCLE_BATCH) toReconcile.push(row);
      }
    }

    for (const row of toReconcile) {
      try {
        const outcome = await step.run(`reconcile-${row.id}`, () => requeue(row, { invariant: 'I5', reconcileOnly: true }));
        if (outcome === 'sent') report.i5Reconciled += 1;
        else countSkip(outcome, row.id);
      } catch (e) {
        report.errors += 1;
        logger.error('Cykl życia: uzgodnienie zalegającej wysyłki nieudane', { invoiceId: row.id, error: e instanceof Error ? e.message : String(e) });
        Sentry.captureException(e, { tags: { job: 'ksef-lifecycle-reconcile', invariant: 'I5' }, extra: { invoiceId: row.id } });
      }
    }
  }

  if (OPERATOR_COUNTERS.some((counter) => report[counter] > 0)) {
    // Nie wyjątek: to decyzja dla operatora, widoczna w /admin/ksef.
    Sentry.captureMessage('Cykl życia faktury: faktury czekają na operatora', {
      level: 'warning',
      tags: { job: 'ksef-lifecycle-reconcile' },
      // Płasko (`<licznik>Ids`) obok liczników — czytelne w Sentry i z zapasem względem
      // normalizeDepth = 3 (głębsze poziomy `extra` Sentry zamienia na „[Array]”).
      extra: {
        ...report,
        ...Object.fromEntries(Object.entries(invoiceIds).map(([counter, ids]) => [`${counter}Ids`, ids])),
      },
    });
  }
  logger.info('Cykl życia: przebieg zakończony', { ...report });
  return report;

  /**
   * Odmowa budowy zlecenia przed zajęciem miejsca w paczce (A5) — ten sam builder
   * co przy zleceniu, bez efektów; `null` = automat może zlecić.
   */
  function refusal(
    row: CandidateRow,
    options: { invariant: 'I5' | 'I6' | 'I7'; reconcileOnly: boolean },
  ): KsefRequeueRefusal | null {
    const built = buildKsefRequeueEvent(row, env, randomUUID(), { reconcileOnly: options.reconcileOnly });
    if (built.ok) return null;
    logRefusal(row, options.invariant, built.reason);
    return built.reason;
  }

  /** `invariant` — ścieżka crona w logu (ta sama faktura może przyjść z I6/I7 albo I5). */
  function logRefusal(row: CandidateRow, invariant: 'I5' | 'I6' | 'I7', reason: KsefRequeueRefusal) {
    // Brak pozycji albo NIP-u to błąd danych; reszta to stan oczekiwany (co 15 min) — bez ostrzeżenia.
    const context = { invoiceId: row.id, invariant, reason };
    if (reason === 'incomplete' || reason === 'no-nip') logger.warn('Cykl życia: faktury nie da się ponowić automatycznie', context);
    else logger.info('Cykl życia: faktury nie da się ponowić automatycznie', context);
  }

  /**
   * Ponowienie przez RPC w transakcji ze zleceniem; aktor NULL = automat.
   * `reconcileOnly` (I5): runner tylko uzgadnia — jak „Tylko uzgodnij” operatora.
   * `invariant` — ścieżka crona w logu (ta sama faktura może przyjść z I6/I7 albo I5).
   * Odmowa buildera tutaj to wyścig (północ między odczytem a zleceniem).
   */
  async function requeue(
    row: CandidateRow,
    options: { invariant: 'I5' | 'I6' | 'I7'; reconcileOnly?: boolean },
  ): Promise<RequeueOutcome> {
    const reconcileOnly = options.reconcileOnly ?? false;
    const built = buildKsefRequeueEvent(row, env, randomUUID(), { reconcileOnly });
    if (!built.ok) {
      logRefusal(row, options.invariant, built.reason);
      return built.reason;
    }
    try {
      await sendJobEvent(built.event, {
        inTransaction: ksefSendTransactionStep(
          { kind: 'requeue', actorUserId: null, reconcileOnly },
          { invoiceId: row.id, tenantId: row.tenant_id, attemptId: built.sendAttemptId },
        ),
      });
    } catch (e) {
      // 00135: inna korekta tej faktury pierwotnej w toku (I5 z rejected) — RPC wycofane
      // bez zlecenia i audytu; ponowi następny przebieg. Każdy inny błąd → errors + Sentry.
      if (isOpenCorrectionConflict(e)) {
        logger.info('Cykl życia: korekta czeka na inną korektę tej faktury pierwotnej', { invoiceId: row.id, invariant: options.invariant });
        return 'conflict';
      }
      throw e;
    }
    return 'sent';
  }
}
