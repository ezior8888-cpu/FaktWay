/**
 * Zdarzenia jobów (etap 10: przeniesione z `lib/inngest/client.ts`, Inngest
 * odpięty 02.10.2026). Każde zdarzenie to nazwa + kształt danych:
 *   - `X.create(data)` buduje `{ name, data }` dla `sendJobEvent` /
 *     `step.sendEvent` (nazwa trafia do kolejek z `EVENT_QUEUE_MAP`),
 *   - `zodEvent` dokłada `.parse()` / `.safeParse()` — bramkę runtime na
 *     wejściu handlera (zły payload kończy job bez bezsensownych ponowień),
 *   - `Parameters<typeof X.create>[0]` to typ danych zdarzenia.
 */

import { z } from 'zod';

import type { Invoice } from '@/types/invoice';
import type { CorrectionInvoiceData, AdvanceInvoiceData, FinalInvoiceData } from '@/types/invoice-types';
import type { AdvanceInvoiceSettlementRow } from '@/lib/ksef/fa3-advance-generator';

export interface JobEventType<T extends object> {
  readonly name: string;
  create(data: T): { name: string; data: T };
}

/** Zdarzenie bez walidacji runtime (kształt pilnuje TypeScript). */
export function jobEvent<T extends object>(name: string): JobEventType<T> {
  return { name, create: (data: T) => ({ name, data }) };
}

/** Zdarzenie z walidacją Zod na wejściu handlera (`.parse` / `.safeParse`). */
export function zodEvent<S extends z.ZodTypeAny>(name: string, schema: S) {
  type Data = z.infer<S> & object;
  return {
    ...jobEvent<Data>(name),
    /** Twardy parse — rzuca `ZodError`, gdy payload nie pasuje. */
    parse(data: unknown): Data {
      return schema.parse(data) as Data;
    },
    /** Bezpieczny parse — `{ success, data | error }`. */
    safeParse(data: unknown) {
      return schema.safeParse(data);
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// EVENT TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Schemat Zod dla `invoice/submit.requested`.
 *
 * Walidacja runtime'owa: chroni przed zniekształconym payloadem (np. brak
 * NIP-u przy replay'u eventu ze starego kodu) — handler robi `.parse()`
 * na wejściu i bezpiecznie kończy się NonRetriableError, zamiast łamać się
 * w środku transakcji KSeF.
 *
 * Domena (`invoice`, `correctionData`, ...) idzie przez `z.custom<T>()` —
 * top-level kształt wymuszamy, ale głębokie pola walidują formularze i
 * generatory XML (RHF + Zod + libxmljs2 XSD).
 */
const InvoiceSubmitRequestedSchema = z.object({
  tenantId: z.string().uuid('tenantId musi być UUID'),
  invoiceId: z.string().uuid('invoiceId musi być UUID'),
  invoice: z.custom<Invoice>(
    (v): v is Invoice => v != null && typeof v === 'object' && !Array.isArray(v),
    { message: 'invoice musi być obiektem domeny' },
  ),
  /** NIP tenanta (klucz rate-limitera + kontekst sesji KSeF). */
  nip: z.string().regex(/^\d{10}$/, 'NIP musi mieć dokładnie 10 cyfr'),
  /** Provenance z chwili enqueue; stare eventy bez niego są odrzucane. */
  environment: z.enum(['test', 'demo', 'production']),
  /** Gdy ustawione, generujemy XML z `generateCorrectionInvoiceXml`. */
  correctionData: z.custom<CorrectionInvoiceData>().optional(),
  /** Faktura ZAL w FA(3). */
  advanceData: z.custom<AdvanceInvoiceData>().optional(),
  /** ROZ — nagłówek bez listy zaliczek; użyj razem z `finalAdvanceSettlementRows`. */
  finalData: z.custom<FinalInvoiceData>().optional(),
  finalAdvanceSettlementRows: z
    .array(z.custom<AdvanceInvoiceSettlementRow>())
    .optional(),
  fromOfflineQueue: z.boolean().optional(),
  offlineQueueId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  /**
   * Identyfikator próby wysyłki — właściciel przejęcia faktury (AUD-10, 00124).
   * Ponowienia tego samego zdarzenia mają ten sam; nowe kolejkowanie — nowy.
   * Stare zdarzenia bez niego przejmują fakturę tylko wolną albo po dzierżawie.
   */
  sendAttemptId: z.string().uuid().optional(),
  /**
   * Tryb „tylko uzgodnij” (operator, `requeue_ksef_send(p_reconcile_only)`):
   * runner uzgadnia poprzednią wysyłkę po numerze referencyjnym i NIGDY nie
   * wysyła faktury od nowa — bez otwartego wpisu `sent` kończy jako
   * `failed RESULT_UNCERTAIN`.
   */
  reconcileOnly: z.boolean().optional(),
});

/** Użytkownik kliknął "Wyślij fakturę do KSeF" w UI. */
export const invoiceSubmitRequested = zodEvent(
  'invoice/submit.requested',
  InvoiceSubmitRequestedSchema,
);

/** Faktura została zaakceptowana przez KSeF i zarchiwizowana w R2. */
export const invoiceSubmitSucceeded = jobEvent<{
    tenantId: string;
    invoiceId: string;
    ksefNumber: string;
    environment: 'test' | 'demo' | 'production';
    /** Opcjonalne — konsumenci mogą pobierać ścieżkę z rekordu faktury w DB. */
    xmlStoragePath?: string;
    fromOfflineQueue?: boolean;
    offlineQueueId?: string;
  }>('invoice/submit.succeeded');

/** Wysyłka do KSeF nieudana (XSD fail, API error, rate-limit wyczerpany). */
export const invoiceSubmitFailed = jobEvent<{
    tenantId: string;
    invoiceId: string;
    error: string;
    environment: 'test' | 'demo' | 'production';
    fromOfflineQueue?: boolean;
    offlineQueueId?: string;
    /**
     * Błąd kończący (odrzucenie treści, brak danych dokumentu) — kolejka
     * Offline24 NIE może takiej faktury ponawiać. Brak pola = jak dotąd
     * (ponowienie), żeby zdarzenia sprzed zmiany działały bez zmian.
     */
    terminal?: boolean;
    /** Local ROZ safety hold: requires reconciliation, not a KSeF rejection. */
    manualReconciliationRequired?: boolean;
    /** Kod z katalogu `ksef_error_codes` (00131) — ten sam, co w `invoices.last_error_code`. */
    errorCode?: string;
  }>('invoice/submit.failed');

/**
 * Przebieg skrzynki jednej firmy. Zlecenia tworzy takt `cron.inbox-polling`
 * dla firm należnych według harmonogramu (00160).
 * `dueAt` = termin z harmonogramu: `started_on − dueAt` w `pgboss.job` to
 * opóźnienie względem harmonogramu (runbook `skrzynka-ksef-pojemnosc.md`).
 * Opcjonalne, bo zlecenia sprzed wdrożenia go nie mają.
 */
export const inboxPollTenant = jobEvent<{
    tenantId: string;
    nip: string;
    environment: 'test' | 'demo' | 'production';
    dueAt?: string;
  }>('inbox/poll.tenant');

/** Znaleziono nową fakturę w skrzynce KSeF (subject2 = nabywca). */
export const inboxInvoiceReceived = jobEvent<{
    tenantId: string;
    ksefNumber: string;
    sellerNip: string;
    sellerName: string;
    grossAmount: number;
    currency: string;
    acquisitionTimestamp: string;
  }>('inbox/invoice.received');

/**
 * Zapisano nową fakturę `incoming` z inbox — worker tworzy `expenses` + KPiR.
 * (Osobno od `inbox/invoice.received`, który służy UI / toast.)
 */
export const inboxInvoiceReceivedAutoCategorize = zodEvent(
  'inbox/invoice-received',
  z.object({
    invoiceId: z.string().uuid('invoiceId musi być UUID'),
    tenantId: z.string().uuid('tenantId musi być UUID'),
    environment: z.enum(['test', 'demo', 'production']),
  }),
);

/**
 * Zaplanuj pobranie UPO dla faktury po akceptacji w KSeF.
 *
 * `nip` to klucz grupy (`groupId`) kolejki UPO w pg-boss — limit per NIP
 * pilnuje, żeby jeden tenant nie zalewał KSeF API.
 */
export const invoiceUpoRequested = jobEvent<{
    invoiceId: string;
    tenantId: string;
    /** NIP tenanta — klucz grupy kolejki UPO (limit per NIP). */
    nip: string;
    ksefNumber: string;
    /**
     * Numer sesji KSeF, w której faktura dostała numer — UPO w KSeF 2.0 leży
     * w zasobach sesji (AUD-17). Opcjonalny: starsze zdarzenia i ponowienia
     * z `upo-retry-stale` biorą go z `ksef_submissions`.
     */
    sessionReferenceNumber?: string;
    environment: 'test' | 'demo' | 'production';
  }>('invoice/upo.requested');

/**
 * Synchronizacja historii KSeF jednej firmy (decyzja Bartosza 22.10.2026 —
 * zastępuje Magiczny import). Fan-out z `cron.ksef-history-sync`; `groupId`
 * = NIP (jeden przebieg na NIP). Środowisko z chwili fan-outu: przebieg
 * w innym środowisku niż `KSEF_ENV` kończy się bez ponowień.
 */
export const ksefHistorySyncTenant = jobEvent<{
    tenantId: string;
    /** NIP tenanta — klucz grupy kolejki (limit per NIP). */
    nip: string;
    environment: 'test' | 'demo' | 'production';
  }>('ksef/history-sync.tenant');

/** Wgrany plik JPK_FA / CSV gotowy do parsowania (ścieżka w R2 z `file-storage`). */
export const importFileUploaded = jobEvent<{
    importJobId: string;
    tenantId: string;
    filePath: string;
    source:
      | 'jpk_fa'
      | 'fakturownia_csv'
      | 'infakt_csv'
      | 'wfirma_csv'
      | 'ifirma_csv';
  }>('import/file.uploaded');

/** Serwer: batch walidacji NIP/VAT kontrahentów (Biała Lista / VIES + cache). */
export const validationBulkContractorsRequested = jobEvent<{
      tenantId: string;
      contractorIds: string[];
      forceRefresh: boolean;
      triggeredBy: string;
    }>('validation/bulk-contractors.requested');

/** Zaplanuj wysyłkę przypomnienia (Po `reminder-scheduler` — job `send-reminder`). */
/**
 * Wysyłka ponaglenia do kontrahenta.
 *
 * `approvalId` jest OBOWIĄZKOWY: żadna wiadomość nie wychodzi w imieniu
 * klienta bez jego kliknięcia (krok 6 planu agenta FLO). Do 24.08.2026 to
 * zdarzenie emitował cron — teraz emituje je wyłącznie akcja uruchomiona
 * przez człowieka albo wykonawca zatwierdzonej propozycji.
 */
export const remindersSendRequested = jobEvent<{
    reminderId: string;
    approvalId: string;
  }>('reminders/send.requested');

/**
 * Zaksięgowano płatność przy fakturze — konsumenci (np. „Wkurzacz”) mogą
 * anulować oczekujące przypomnienia.
 */
export const invoicePaymentReceived = jobEvent<{
    invoiceId: string;
  }>('invoice/payment.received');

/**
 * Faza 25 — Stripe billing events. Emit'owane z `/api/stripe/webhook` po
 * udanej walidacji signature + idempotency check. Konsumenci:
 *   - `billing/payment.succeeded` → self-invoicing przez KSeF (Krok 4)
 *   - §billing/payment.failed§ → dunning email (Krok 5)
 */
export const billingPaymentSucceeded = jobEvent<{
    tenantId: string;
    paymentId: string;
    stripeInvoiceId: string;
    /** Amount + VAT w groszach (PLN). */
    amountCents: number;
    taxCents: number;
    currency: string;
    paidAt: string;
    /**
     * Rodzaj metody ze sprawdzonego Charge (`card`, `blik`): forma płatności na
     * fakturze. Job sprzed BLIK-a go nie ma, wtedy płatność mogła być tylko kartą.
     */
    paymentMethodType?: string;
  }>('billing/payment.succeeded');

export const billingPaymentFailed = jobEvent<{
    tenantId: string;
    paymentId: string;
    stripeInvoiceId: string;
    failureReason: string | null;
  }>('billing/payment.failed');

/** Uruchom generowanie pliku eksportu (worker pg-boss). */
export const exportsGenerateRequested = jobEvent<{
    exportJobId: string;
  }>('exports/generate.requested');

/** Paczka dla księgowego — generowanie ZIP / e‑mail Co‑Pilot. */
export const exportsCoPilotSendPackage = jobEvent<{
      tenantId: string;
      periodStart: string;
      periodEnd: string;
      formats: string[];
      accountantEmail: string;
      accountantName: string | null;
      manual: boolean;
    }>('exports/co-pilot.send-package');

const TrialOnboardingEmailPayloadSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
});

/** Rejestracja użytkownika — start sekwencji trialowych maili. */
export const userRegistered = zodEvent('user/registered', TrialOnboardingEmailPayloadSchema);

export const emailTrialDay1 = zodEvent('email/trial-day-1', TrialOnboardingEmailPayloadSchema);
export const emailTrialDay4 = zodEvent('email/trial-day-4', TrialOnboardingEmailPayloadSchema);
export const emailTrialDay8 = zodEvent('email/trial-day-8', TrialOnboardingEmailPayloadSchema);
export const emailTrialDay12 = zodEvent('email/trial-day-12', TrialOnboardingEmailPayloadSchema);
export const emailTrialDay14 = zodEvent('email/trial-day-14', TrialOnboardingEmailPayloadSchema);

/** OCR zdjęcia wydatku — worker aktualizuje `ocr_jobs` i tworzy `expenses`. */
export const ocrProcessPhotoRequested = zodEvent(
  'ocr/process-photo',
  z.object({
    ocrJobId: z.string().uuid('ocrJobId musi być UUID'),
    tenantId: z.string().uuid('tenantId musi być UUID'),
  }),
);
