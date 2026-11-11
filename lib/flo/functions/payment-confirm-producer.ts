/**
 * K-01 — producent w pulsie (zadanie 1.1 planu FLO 2).
 *
 * Do tej pory K-01 miało funkcje czyste i wykonawcę, ale nikt nie tworzył
 * karty. Ten plik jest tym „kimś": raz dziennie, w `flo.tick`, patrzy na
 * faktury po terminie i zadaje JEDNO pytanie „zapłacił?".
 *
 * Osobno od `payment-confirm.ts` z tego samego powodu, dla którego
 * `audit-sweep.ts` jest osobno od `ksef-audit.ts`: tamten plik jest czysty
 * i testowalny bez bazy, tutaj mieszka odczyt i decyzja, KIEDY pytać.
 *
 * CZTERY ZASADY, KTÓRE TEN PLIK PILNUJE:
 *
 * 1. JEDNA ŻYWA KARTA K-01 NA KONTO. Pięć zaległości to nie pięć pytań naraz,
 *    tylko kolejka: następne pytanie pojawia się, gdy poprzednie zostało
 *    rozstrzygnięte. Pytanie o największą kwotę idzie pierwsze.
 *
 * 2. PYTAM RAZ. Faktura, o którą już pytaliśmy i człowiek odpowiedział,
 *    odrzucił albo przemilczał kartę do wygaśnięcia, nie wraca. Dalsze
 *    upominanie się o pieniądze to robota K-02, nie K-01.
 *
 * 3. KARTA NIE KŁAMIE O ŚWIECIE. Jeśli faktura została opłacona (import
 *    wyciągu, ręczne oznaczenie), otwarta karta o nią znika przy najbliższym
 *    przebiegu, a nie wisi do kliknięcia albo do wygaśnięcia za miesiąc.
 *
 * 4. KONTO WYŁĄCZONE NIE KOSZTUJE ODCZYTU FAKTUR — chyba że jedyną
 *    przeszkodą jest kanarek. Wyłącznik, blokadę z kodu, wpis operatora
 *    i wyciszenie sprawdzamy PRZED zapytaniem o faktury. Konto poza
 *    kanarkiem idzie dalej: agent liczy, o co by zapytał, a `createProposal`
 *    zapisuje to w trybie cichym zamiast karty (`shouldCompute`). Bez tego
 *    nie da się zmierzyć trafności przed odsłonięciem.
 *
 * ŚWIADOMIE BEZ ROZSYŁANIA PO KOLEJCE `flo.tick.tenant`. Plan (1A) opisuje
 * to jako docelowy wzorzec, ale nowa kolejka zmienia układ workera i jest
 * decyzją Bartosza. Do tego czasu przebieg idzie po kontach po kolei, z
 * odczytem ograniczonym do okna i z izolacją błędów — padnięte konto nie
 * przewraca pulsu pozostałych. `producePaymentConfirm` działa na jednym
 * koncie, więc przyszłe zadanie per konto zawoła ją bez zmian.
 */

import { RECEIPT_REVENUE_COLUMNS } from '@/lib/invoices/receipt-revenue-guard';
import { isReceiptInvoice } from '@/lib/reminders/delivery-schema';
import { unlimitedCap, type DailyCap } from '@/lib/flo/daily-cap';
import { floDb, type FloDbClient, type FloProposalRow } from '@/lib/flo/db-types';
import { isMuted } from '@/lib/flo/decisions';
import { buyerName, readState, type FloState } from '@/lib/flo/fingerprint';
import {
  buildInvoiceConfirmProposal,
  selectOverdueForConfirmation,
  type OverdueInvoice,
} from '@/lib/flo/functions/payment-confirm';
import { isKindEnabledForTenant, shouldCompute } from '@/lib/flo/kind-switch';
import { createProposal } from '@/lib/flo/proposals';
import { runSweep, type FloSweepResult } from '@/lib/flo/sweep';
import type { JobLogger } from '@/lib/jobs/logger';
import { createAdminClient } from '@/lib/supabase/admin';
import { CHASEABLE_INVOICE_KINDS } from '@/lib/reminders/scheduler';
import { amountDueOf } from '@/lib/invoices/amount-due';

const KIND = 'payment.confirm' as const;
const TOPIC_PREFIX = `${KIND}:`;

/**
 * Pytamy o świeże zaległości. Faktura dwa miesiące po terminie to sprawa,
 * o której klient na pewno wie, a dalsze upominanie się o nią to robota
 * K-02 — pytanie „zapłacił?" po kwartale brzmi jak zarzut.
 */
export const LOOKBACK_DAYS = 60;

/** Górny limit odczytu faktur jednego konta. Pytamy i tak o jedną. */
const INVOICE_LIMIT = 100;

/**
 * Ile ostatnich kart K-01 konta czytamy, żeby wiedzieć, o co już pytaliśmy.
 * Nowa karta powstaje najwyżej raz dziennie, a faktura wypada z okna po
 * `LOOKBACK_DAYS` — ponad rok historii to zapas z nawiązką.
 */
const HISTORY_LIMIT = 400;

// ═══════════════════════════════════════════════════════════════
// Źródła danych — wstrzykiwalne, żeby testy nie sięgały po bazę
// ═══════════════════════════════════════════════════════════════

export interface PaymentConfirmSources {
  /** Faktury wystawione jednego konta, po terminie, jeszcze nieopłacone. */
  readOverdueInvoices: (tenantId: string, now: Date) => Promise<OverdueInvoice[]>;
  /**
   * Fakty faktury do odcisku. Produkcyjnie to `readState` z `fingerprint.ts`,
   * czyli dokładnie ten odczyt, który zrobi re-walidacja przy kliknięciu.
   */
  readInvoiceState: (invoiceId: string, tenantId: string) => Promise<FloState>;
  /** Globalny wyłącznik — wstrzykiwany tylko w testach. */
  readGlobalKill?: () => Promise<boolean>;
}

export function productionPaymentConfirmSources(): PaymentConfirmSources {
  return {
    readOverdueInvoices,
    readInvoiceState: (invoiceId, tenantId) => readState(KIND, { invoiceId }, tenantId),
  };
}

/**
 * Ta sama definicja „faktury po terminie" co w cronie ponagleń
 * (`findInvoicesRequiringReminders`): wystawiona, przyjęta przez KSeF,
 * nieopłacona. „Wystawiona" to w bazie `direction = 'outgoing'` — do 25.09
 * stało tu 'issued' (nazwa z API KSeF), którego tabela faktur nie zna,
 * więc reguła nie znajdowała ani jednej faktury. Inaczej K-01 i K-02 spierałyby się o to, co jest zaległe.
 *
 * Plus jeden warunek własny: `origin = 'app'`. Import historii nie
 * odblokowuje pytań wstecz (plan FLO 2, 1.19) — zaciągnięte z KSeF faktury
 * są „nieopłacone" tylko dlatego, że import nie zna wyciągów, a klient
 * rozliczył je dawno w innym programie. Znacznik z migracji 00065 jest
 * trwały, w odróżnieniu od prefiksu w edytowalnych `notes`.
 */
async function readOverdueInvoices(
  tenantId: string,
  now: Date,
): Promise<OverdueInvoice[]> {
  const today = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await createAdminClient()
    .from('invoices')
    .select(
      `id, internal_number, buyer_data, gross_total, paid_amount, payment_due_date, reminders_paused, invoice_kind, payment_data, ${RECEIPT_REVENUE_COLUMNS}`,
    )
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('origin', 'app')
    .eq('ksef_status', 'accepted')
    // Korekta nie jest osobnym długiem — jak w cronie ponagleń.
    .in('invoice_kind', [...CHASEABLE_INVOICE_KINDS])
    .in('payment_status', ['unpaid', 'partial', 'overdue'])
    .lt('payment_due_date', today)
    .gte('payment_due_date', since)
    .order('payment_due_date', { ascending: false })
    .limit(INVOICE_LIMIT);

  if (error) throw new Error(error.message);

  // Krok 1.2: faktura do paragonu jest zapłacona przy kasie, więc FLO nie pyta, czy klient zapłacił.
  return (data ?? []).filter((row) => !isReceiptInvoice(row)).flatMap((row) =>
    row.payment_due_date
      ? [
          {
            id: row.id,
            // Te same zapasowe napisy co w `readState` — karta i zdanie
            // o zmianie mają mówić o fakturze tak samo.
            number: row.internal_number ?? 'bez numeru',
            contractorName: buyerName(row.buyer_data) ?? 'Kontrahent',
            grossTotal: Number(row.gross_total ?? 0),
            // ROZ: do zapłaty jest reszta po zaliczkach (C-16, 00145).
            amountDue: amountDueOf({
              invoice_kind: row.invoice_kind, gross_total: row.gross_total,
              payment_data: row.payment_data,
            }),
            paidAmount: Number(row.paid_amount ?? 0),
            dueDate: row.payment_due_date,
            remindersPaused: row.reminders_paused,
          },
        ]
      : [],
  );
}

// ═══════════════════════════════════════════════════════════════
// Jedno konto
// ═══════════════════════════════════════════════════════════════

export type PaymentConfirmOutcome =
  /**
   * Wyłącznik, blokada, wpis operatora — faktur nawet nie czytaliśmy.
   * Konto poza kanarkiem też kończy tutaj, ale PO odczycie: pytanie trafiło
   * do trybu cichego, nie do klienta.
   */
  | 'disabled'
  /** Klient wyciszył te pytania — faktur nawet nie czytaliśmy. */
  | 'muted'
  /** Żywa karta dalej aktualna — odświeżona w miejscu, nowej nie ma. */
  | 'waiting'
  | 'created'
  /** Nie ma o co pytać. */
  | 'nothing';

export interface PaymentConfirmResult {
  outcome: PaymentConfirmOutcome;
  /** Otwarte karty zamknięte, bo faktura przestała być zaległa. */
  closed: number;
}

type HistoryRow = Pick<
  FloProposalRow,
  'id' | 'topic_key' | 'status' | 'dismissed_reason' | 'expires_at'
>;

export async function producePaymentConfirm(
  tenantId: string,
  now: Date,
  db: FloDbClient,
  sources: PaymentConfirmSources,
  /** Dzienny limit nowych kart na konto — patrz `daily-cap.ts`. */
  cap: DailyCap = unlimitedCap(),
): Promise<PaymentConfirmResult> {
  const verdict = await isKindEnabledForTenant(
    KIND,
    tenantId,
    db,
    sources.readGlobalKill,
  );
  if (!shouldCompute(verdict)) return { outcome: 'disabled', closed: 0 };
  if (await isMuted(tenantId, KIND, now, db)) {
    return { outcome: 'muted', closed: 0 };
  }

  const history = await readHistory(tenantId, db);
  const selection = selectOverdueForConfirmation(
    await sources.readOverdueInvoices(tenantId, now),
    now,
  );
  const overdue = new Map(selection.map((entry) => [entry.invoice.id, entry]));

  // ── 1. Karty, które już wiszą ──────────────────────────────
  let closed = 0;
  let live = 0;

  for (const card of history.filter(isLive)) {
    const entry = overdue.get(invoiceIdOf(card));

    if (card.status !== 'open') {
      // Zatwierdzona albo w trakcie wykonania: człowiek już się zgodził.
      // Nie podmieniamy jej pod ręką — re-walidacja przy wykonaniu i tak
      // zatrzyma ją, jeśli świat się zmienił.
      live++;
      continue;
    }

    if (!entry) {
      if (await closeOutdated(card.id, db)) closed++;
      continue;
    }

    // Faktura dalej zaległa: aktualizujemy liczbę dni i odcisk, ale NIE
    // termin ważności. Odświeżanie terminu przy każdym przebiegu sprawiłoby,
    // że przemilczana karta nie wygaśnie nigdy.
    const refreshed = await askAbout(
      tenantId,
      entry.invoice.id,
      now,
      db,
      sources,
      new Date(card.expires_at),
    );

    // Lista faktur mówiła „zaległa", ale odczyt faktury, z którego powstaje
    // karta, już nie. Wierzymy świeższemu odczytowi: karta zostawiona
    // w spokoju pytałaby o wpłatę, o której system już wie.
    if (refreshed === 'skipped') {
      if (await closeOutdated(card.id, db)) closed++;
      continue;
    }
    live++;
  }

  if (live > 0) return { outcome: 'waiting', closed };

  // ── 2. Następne pytanie ────────────────────────────────────
  const asked = new Set(history.filter(wasAsked).map(invoiceIdOf));

  for (const entry of selection) {
    if (asked.has(entry.invoice.id)) continue;

    // Limit dotyczy WYŁĄCZNIE nowych pytań. Zamykanie nieaktualnych kart
    // i odświeżanie żywych dzieje się wyżej i nie zależy od niego.
    if (!cap.canAsk(tenantId)) return { outcome: 'nothing', closed };

    const outcome = await askAbout(tenantId, entry.invoice.id, now, db, sources);
    if (outcome === 'skipped') continue;
    if (outcome === 'created') cap.spend(tenantId);
    return { outcome, closed };
  }

  return { outcome: 'nothing', closed };
}

/**
 * Stawia albo odświeża kartę o jednej fakturze.
 *
 * Z listy faktur po terminie bierzemy TYLKO identyfikator. Kwoty, numer
 * i termin na karcie pochodzą z `readInvoiceState` — tego samego odczytu,
 * z którego liczy się odcisk. Lista i ten odczyt to dwa zapytania w dwóch
 * chwilach; wpłata, która wpadła pomiędzy, dawała kartę z nieaktualną kwotą
 * i aktualnym odciskiem, czyli taką, której re-walidacja nie zatrzyma.
 */
async function askAbout(
  tenantId: string,
  invoiceId: string,
  now: Date,
  db: FloDbClient,
  sources: PaymentConfirmSources,
  keepExpiresAt?: Date,
): Promise<'created' | 'disabled' | 'muted' | 'skipped'> {
  const state = await sources.readInvoiceState(invoiceId, tenantId);

  // `null`, gdy według tego odczytu nie ma o co pytać: faktura zniknęła,
  // została opłacona, wstrzymana albo przestała być przyjęta przez KSeF.
  const card = buildInvoiceConfirmProposal({ tenantId, invoiceId, state, now });
  if (!card) return 'skipped';

  const result = await createProposal(
    keepExpiresAt ? { ...card, expiresAt: keepExpiresAt } : card,
    db,
    sources.readGlobalKill,
  );

  switch (result.status) {
    case 'created':
    case 'updated':
      return 'created';
    case 'muted':
      return 'muted';
    default:
      return 'disabled';
  }
}

async function readHistory(
  tenantId: string,
  db: FloDbClient,
): Promise<HistoryRow[]> {
  const { data, error } = await db
    .from('flo_proposals')
    .select('id, topic_key, status, dismissed_reason, expires_at')
    .eq('tenant_id', tenantId)
    .eq('kind', KIND)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) throw new Error(error.message);
  return (data ?? []) as HistoryRow[];
}

/**
 * Zamyka otwartą kartę o fakturze, która przestała być zaległa.
 *
 * Powód `stale`, bo to jest dokładnie to zdarzenie: dane zmieniły się po
 * pokazaniu karty. Warunek `status = 'open'` chroni przed wyścigiem
 * z człowiekiem, który klika w tej samej sekundzie — jego kliknięcie wygrywa.
 */
async function closeOutdated(id: string, db: FloDbClient): Promise<boolean> {
  const { data, error } = await db
    .from('flo_proposals')
    .update({ status: 'expired', dismissed_reason: 'stale' })
    .eq('id', id)
    .eq('status', 'open')
    .select('id');

  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

function isLive(card: HistoryRow): boolean {
  return (
    card.status === 'open' ||
    card.status === 'approved' ||
    card.status === 'executing'
  );
}

/**
 * Czy o tę fakturę już pytaliśmy — w rozumieniu „pytam raz".
 *
 * Tak: odpowiedź (`done`), każde odrzucenie (także cofnięcie — człowiek
 * powiedział, że jednak nie zapłacił) i karta przemilczana do wygaśnięcia.
 * Nie: karta zamknięta, bo zmieniły się dane (`stale`) — wtedy pytanie
 * dotyczyło innego stanu faktury i nikt na nie nie odpowiedział.
 */
function wasAsked(card: HistoryRow): boolean {
  if (card.status === 'done' || card.status === 'dismissed') return true;
  return card.status === 'expired' && card.dismissed_reason === 'auto_expired';
}

function invoiceIdOf(card: HistoryRow): string {
  return card.topic_key.startsWith(TOPIC_PREFIX)
    ? card.topic_key.slice(TOPIC_PREFIX.length)
    : '';
}

// ═══════════════════════════════════════════════════════════════
// Wszystkie konta
// ═══════════════════════════════════════════════════════════════


export async function runPaymentConfirmSweep(
  tenantIds: readonly string[],
  now: Date = new Date(),
  db: FloDbClient = floDb(),
  sources: PaymentConfirmSources = productionPaymentConfirmSources(),
  logger?: Pick<JobLogger, 'error'>,
  cap: DailyCap = unlimitedCap(),
): Promise<FloSweepResult> {
  return runSweep(
    KIND,
    tenantIds,
    async (tenantId) => {
      const { outcome, closed } = await producePaymentConfirm(
        tenantId,
        now,
        db,
        sources,
        cap,
      );
      return { asked: outcome === 'created' ? 1 : 0, closed };
    },
    logger,
  );
}
