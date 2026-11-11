import { headers } from 'next/headers';
import { trustedClientIp } from '@/lib/auth/client-ip';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * Adres w kolejności zaufania limitów prób (`X-Real-Ip` od Traefika, potem
 * ostatni wpis `X-Forwarded-For`), nie pierwszy wpis, który podaje sam klient.
 * Pokazuje go lista zalogowanych urządzeń (00174, krok 8.5), więc logujący się
 * z cudzym hasłem nie może podpisać się adresem ofiary. Wartość, która nie jest
 * adresem, to `null`: inaczej INSERT do kolumny INET pada i wpis znika.
 */
async function readRequestClientHints(): Promise<{
  ip: string | null;
  userAgent: string | null;
}> {
  try {
    const hdrs = await headers();
    const ip = trustedClientIp(hdrs);
    const userAgent = hdrs.get('user-agent') ?? null;
    return { ip, userAgent };
  } catch {
    return { ip: null, userAgent: null };
  }
}

/**
 * Kanoniczne akcje audytu. Rozszerzaj listę w miarę dodawania features.
 * Nie używaj surowych stringów poza tym unionem.
 */
export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.signup'
  | 'auth.password_reset_requested'
  | 'auth.password_changed'
  | 'auth.mfa_enrolled'
  | 'auth.mfa_unenrolled'
  | 'auth.mfa_challenge_succeeded'
  | 'auth.mfa_challenge_failed'
  | 'auth.mfa_recovery_code_used'
  | 'auth.mfa_recovery_codes_regenerated'
  | 'auth.passkey_added'
  | 'auth.passkey_removed'
  // Wylogowanie na odległość (00174, krok 8.5): jedno urządzenie (`metadata.session_id`)
  // albo wszystkie poza bieżącym (`metadata.count`). Wpis `auth.login` niesie od
  // tego kroku `metadata.session_id`, po którym lista urządzeń łączy sesję z przeglądarką.
  | 'auth.session_revoked'
  | 'auth.other_sessions_revoked'
  | 'gdpr.export_requested'
  | 'gdpr.deletion_requested'
  | 'gdpr.deletion_canceled'
  | 'gdpr.deletion_executed'
  | 'gdpr.deletion_failed'
  | 'tenant.created'
  | 'tenant.updated'
  | 'tenant.user_role_changed'
  | 'tenant.ksef_verified'
  | 'tenant.ksef_nip_ownership_claimed'
  // Wątek przy koszcie (00192): prośba o dokument i jej załatwienie; metadane niosą identyfikator
  // wpisu i rolę, bez treści. Zapisuje baza (RPC `expense_comment_add`, `expense_document_request_resolve`).
  | 'expense.document_requested'
  | 'expense.document_request_resolved'
  | 'expense.foreign_currency_reviewed'
  | 'expense.foreign_currency_excluded'
  // Agent FLO — wykonanie propozycji zatwierdzonej kliknięciem człowieka.
  // Metadane niosą identyfikator żetonu zgody i tytuł, który klient widział
  // na karcie: to jest odpowiedź na reklamację „ja tego nie klikałem”.
  | 'flo.proposal.executed'
  | 'flo.proposal.failed'
  | 'flo.proposal.undone'
  | 'invoice.draft_created'
  | 'invoice.draft_updated'
  | 'invoice.draft_deleted'
  | 'invoice.submit_requested'
  | 'invoice.submit_redirected_offline'
  | 'invoice.submit_succeeded'
  | 'invoice.submit_failed'
  | 'invoice.upo_downloaded'
  | 'invoice.xml_downloaded'
  // Panel operatora /admin/ksef (cykl życia faktury, PR 3c) — aktor = operator.
  | 'invoice.operator_requeue'
  | 'invoice.operator_reconcile'
  | 'invoice.operator_reset'
  // D-A4-1b-3 PR B: operator zapisał decyzję klienta przy nierozstrzygniętym 440
  // (decyzję zapisuje RPC `decide_ksef_duplicate` — `invoice.ksef_duplicate_decided`).
  // PR C (00156): metadane niosą też `mode`, `offer` i `importedInvoiceId` (K zapisana z KSeF; brak przy `no-import`).
  | 'invoice.operator_duplicate_decision'
  // D-A4-1b-3 PR D: klient (właściciel/administrator) kliknął „Sprawdź ponownie” przy braku danych oryginału 440.
  // Metadane: `reason`, `originalKsefNumber`, `sendAttemptId`; z tego wpisu liczymy cooldown 10 minut.
  | 'invoice.duplicate_recheck'
  // D-A4-1b-3 PR B: „Faktura … czeka na Twoją decyzję” dostarczone (e-mail albo push) —
  // zapis bezpośredni (`lib/ksef/duplicate-decision-notice.ts`), raz na (fakturę, K).
  // PR C: metadane niosą `variant` (`pair` / `record` / `released` / `review`).
  | 'invoice.ksef_duplicate_decision_notified'
  // D-A4-1b-3 PR C (00156, spec v3 6.6): zapis oryginału z KSeF decyzją (RPC `decide_ksef_duplicate_original`,
  // tryb `import`), oddanie decyzji klientowi po przeglądzie pliku (RPC `release_ksef_original_review`) i trwały
  // znacznik „sprawdź ponownie” (RPC `flag_ksef_original_recheck`) — zapisuje baza (`ksef_send_audit`), nie aplikacja.
  | 'invoice.ksef_original_imported'
  | 'invoice.ksef_original_review_released'
  | 'invoice.ksef_original_recheck_flagged'
  // PR C: operator oddał decyzję klientowi (`operatorReleaseOriginalReviewAction`, notatka operatora, tylko nowe oddanie).
  | 'invoice.operator_original_release'
  | 'invoice.emailed'
  // Link do faktury dla nabywcy (00179, krok 2.10): metadane niosą `linkId` (nigdy token),
  // przy utworzeniu termin, przy cofnięciu powód (`manual` albo `replaced` przez nowy link).
  | 'invoice.share_link_created'
  | 'invoice.share_link_revoked'
  | 'invoice.resubmit_requested'
  // Noty obciążeniowe i uznaniowe (00193, krok 2.9): szkic zapisuje aplikacja (metadane:
  // rodzaj, suma, liczba pozycji); wystawienie (numer) i wysyłkę mailem (adres, id wiadomości)
  // zapisuje baza (RPC `issue_accounting_note`, `record_accounting_note_email`) w tej samej transakcji.
  | 'accounting_note.draft_created'
  | 'accounting_note.draft_updated'
  | 'accounting_note.draft_deleted'
  | 'accounting_note.issued'
  | 'accounting_note.emailed'
  // „Zapłacone” jednym dotknięciem (00158): metadane niosą kwotę, dzień zapłaty i liczbę przypomnień.
  // Zapisuje baza (RPC `mark_invoice_paid` i `undo_invoice_paid`) w transakcji z wpłatą, nie aplikacja.
  | 'invoice.marked_paid'
  | 'invoice.paid_undone'
  // Wpłaty częściowe i historia wpłat (00176, plan kompletnej aplikacji 3.1): metadane niosą
  // wpłatę, kwotę, dzień wpłaty, resztę, stan płatności i liczbę przypomnień. Zapisuje baza
  // (RPC `record_invoice_payment` i `void_invoice_payment`) w transakcji z wpłatą, nie aplikacja.
  | 'invoice.payment_recorded'
  | 'invoice.payment_voided'
  // Import wyciągu bankowego (00180, plan kompletnej aplikacji 3.2): metadane bez danych osób
  // trzecich (liczby, kwota, dzień, rodzaj dopasowania). Zapisuje baza (RPC `import_bank_operations`,
  // `confirm_bank_operation`, `skip_bank_operation`, `undo_bank_operation`), nie aplikacja.
  | 'bank.statement_imported'
  | 'bank.operation_confirmed'
  | 'bank.operation_skipped'
  | 'bank.operation_undone'
  // Przelewy do ZUS i urzędu jako zapłaty rozliczeń (00189, plan kompletnej aplikacji 3.2, część 2):
  // metadane z rozliczeniami, dniem zapłaty, kwotą z banku, wyliczoną i różnicą. Zapisuje baza
  // (RPC `confirm_bank_tax_payment`, `undo_bank_tax_payment`) razem z `tax_settlement.paid`/`unpaid`.
  | 'bank.tax_payment_confirmed'
  | 'bank.tax_payment_undone'
  // Kasa (00194, plan kompletnej aplikacji 3.7): stan początkowy kasy, dowody KP i KW
  // i ich korekty (storno). Metadane: numer, rodzaj, kwota, dzień operacji, faktura
  // i wpłata. Zapisuje baza (RPC `open_cash_register`, `issue_cash_document`,
  // `correct_cash_document`) w transakcji z dowodem, nie aplikacja.
  | 'cash_register.opened'
  | 'cash_register.opening_changed'
  | 'cash_document.issued'
  | 'cash_document.corrected'
  // Faktury cykliczne (plan Finora N1) — pozycja tylko przypomina, fakturę
  // wystawia człowiek „Wystaw i wyślij do KSeF” (`components/invoices/actions.ts`).
  | 'recurring_invoice.created'
  | 'recurring_invoice.updated'
  | 'recurring_invoice.paused'
  | 'recurring_invoice.resumed'
  | 'recurring_invoice.deleted'
  /** Faktura z pozycji zajęła okres; metadane: invoiceId, recurringPeriod, from/toNextRunDate, nextRunDateAdvanced. */
  | 'recurring_invoice.issued'
  /** Samonaprawa po 23505: za okres była już faktura, `next_run_date` przesunięta dopiero teraz. */
  | 'recurring_invoice.run_date_repaired'
  /** Usunięto szkic, który zajmował okres — `next_run_date` cofnięta o ten okres. */
  | 'recurring_invoice.run_date_restored'
  | 'ksef.credentials_uploaded'
  | 'ksef.credentials_removed'
  | 'ksef.environment_changed'
  // Ostrzeżenie o wygasającym certyfikacie dostarczone (mail albo push) —
  // zadanie cert-expiry-alert czyta stąd, które progi już wysłało (AUD-53).
  | 'ksef.cert_expiry_alert'
  // Faza 23 sekcja 3 — audyt interakcji z KSeF API. Odpytywanie (`*.poll`):
  // wiersz błędu żądania i wiersz podsumowania z `metadata.summary` (EXT-03).
  | 'ksef.session.open'
  | 'ksef.session.close'
  | 'ksef.invoice.send'
  | 'ksef.invoice.poll'
  | 'ksef.upo.download'
  | 'ksef.inbox.poll'
  | 'ksef.auth.token'
  // Synchronizacja historii KSeF (decyzja Bartosza 22.10.2026): zapytanie
  // o metadane (każde, przez ksefFetch), jeden zbiorczy wiersz pobrań na
  // przebieg (liczba + do 10 numerów KSeF) i wyłącznik właściciela firmy.
  | 'ksef.history.query'
  | 'ksef.history.download'
  | 'ksef.history.paused'
  | 'ksef.history.resumed'
  // Zapis operatora skryptem `scripts/ops/ksef-historia.sh` (odblokuj, wznow, wstrzymaj-wszystko) — SQL, nie aplikacja.
  | 'ksef.history.operator'
  // Faza 24 — admin panel actions.
  | 'admin.user.suspended'
  | 'admin.user.unsuspended'
  | 'admin.user.force_logout'
  | 'admin.user.password_reset_triggered'
  | 'admin.user.deleted'
  | 'admin.note.created'
  | 'admin.note.archived'
  | 'admin.flag.toggled'
  /** Odsłonięcie, rozwinięcie albo schowanie funkcji agenta w kanarku. */
  | 'admin.flo.rollout.changed'
  // Faza 25 — Stripe billing lifecycle.
  | 'billing.customer.created'
  | 'billing.checkout.session_created'
  /** Stripe nie zaoferował BLIK-a mimo `STRIPE_BLIK_RECURRING=on` (odmowa albo filtr). */
  | 'billing.checkout.blik_unavailable'
  | 'billing.subscription.created'
  | 'billing.subscription.updated'
  | 'billing.subscription.synced'
  | 'billing.subscription.canceled'
  | 'billing.payment.succeeded'
  | 'billing.payment.failed'
  | 'billing.refund.issued'
  | 'billing.refund.reconciliation_required'
  | 'billing.trial.will_end'
  | 'billing.vat_invoice.queued'
  // Plik dokumentu kosztu w portalu księgowej (krok 6.2): metadane niosą `accessId`
  // i rodzaj pliku (`photo` albo `xml`), bez treści dokumentu i bez ścieżki magazynu.
  | 'accountant.expense_file_viewed'
  | 'accountant.expense_file_downloaded'
  // Adres kalendarza (00182, krok 7.3 planu kompletnej aplikacji): bez tokenu i jego skrótu w metadanych.
  | 'calendar_feed.created'
  | 'calendar_feed.regenerated'
  | 'calendar_feed.deleted'
  | 'accountant.token_created'
  | 'accountant.token_revoked'
  | 'accountant.access_used'
  | 'accountant.portal_export'
  // Publiczne API (00181, krok 7.1): zapisuje baza, nie aplikacja. Utworzenie
  // i odwołanie klucza wyzwalacz `audit_api_key_change` (nazwa, prefiks, zakresy),
  // każde użycie `api_key_session()` (punkt, identyfikator żądania, adres, bez treści odpowiedzi).
  | 'api_key.created'
  | 'api_key.revoked'
  | 'api_key.used'
  // Webhooki publicznego API (00187, krok 7.1, część 3): zapisuje baza wyzwalaczem
  // `audit_webhook_endpoint_change` (nazwa serwera i zdarzenia, bez ścieżki adresu i sekretu).
  // `webhook.auto_disabled`: po 20 nieudanych dostawach z rzędu, bez autora (worker).
  | 'webhook.created'
  | 'webhook.deleted'
  | 'webhook.enabled'
  | 'webhook.auto_disabled'
  // Kontrahenci — poprawka danych i usunięcie z bazy (audyt bloku 1, F-011).
  | 'contractor.updated'
  | 'contractor.deleted'
  | 'retention.deletion_requested'
  | 'retention.deletion_executed'
  | 'invitation.created'
  | 'invitation.revoked'
  | 'invitation.accepted'
  | 'join_request.created'
  | 'join_request.approved'
  | 'join_request.denied'
  | 'membership.revoked'
  | 'membership.role_changed'
  // Dokumenty prawne i zgody (lib/legal/record.ts). Metadane niosą wersję
  // dokumentu i wersję brzmienia oświadczenia (lib/legal/versions.ts).
  | 'legal.terms_accepted'
  | 'legal.checkout_statement_accepted'
  | 'legal.email_consent_granted'
  | 'legal.email_consent_withdrawn'
  // Zgoda na analitykę (00161): kto, kiedy i na jakie brzmienie (ANALYTICS_STATEMENT).
  | 'analytics.consent_changed'
  // Archiwum dokumentów i paczka na kontrolę (00178, krok 6.4 planu kompletnej
  // aplikacji): zlecenie (rodzaj i okres) i pobranie gotowej paczki.
  | 'document_archive.requested'
  | 'document_archive.downloaded'
  // Plik wygasłej paczki usunięty z magazynu (00190, krok 6.4, część 2). Wpis
  // dopisuje funkcja bazy `mark_document_archive_file_deleted` razem ze znacznikiem.
  | 'document_archive.file_deleted'
  // Profil podatkowy (00166, plan księgowości JDG K2): wersja przed i po zapisie.
  | 'tax_profile.saved'
  // Ewidencja przychodów (00167, K3): wpis ręczny dodany albo usunięty (cała
  // treść wpisu) i pobrany plik JPK_EWP (okres i sumy, bez danych osoby).
  | 'ledger_entry.created'
  | 'ledger_entry.deleted'
  | 'jpk_ewp.downloaded'
  // Rozliczenie miesiąca (00168, K4, D6): zatwierdzone wersje i oznaczenie zapłaty.
  | 'tax_settlement.approved'
  | 'tax_settlement.paid'
  | 'tax_settlement.unpaid'
  | 'tax_settlement.manual_paid'
  // VAT i JPK_V7M (00170, K6): pobrany plik (miesiąc i kwoty deklaracji, bez
  // danych osoby), wysyłka do MF z numerem referencyjnym i przyjęcie z UPO.
  | 'jpk_v7m.downloaded'
  | 'jpk_v7m.sent'
  | 'jpk_v7m.accepted'
  // KPiR (00171, K7): wpis ręczny KPiR dodany (usunięcie jak w K3) i pobrany
  // plik JPK_PKPIR (okres i sumy, bez danych osoby).
  | 'ledger_entry.kpir_created'
  | 'ledger_inventory.created'
  | 'ledger_inventory.deleted'
  | 'jpk_pkpir.downloaded';

export interface AuditLogEntry {
  action: AuditAction;
  tenantId: string | null;
  userId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Zapisuje wpis do audit_logs. Wywołuj z Server Actions po ważnych operacjach.
 *
 * Nie rzuca — przy błędzie audytu główna operacja ma się i tak udać.
 */
export async function logAudit(entry: AuditLogEntry): Promise<void> {
  try {
    const { ip, userAgent } = await readRequestClientHints();

    const supabase = createAdminClient();
    const { error } = await supabase.from('audit_logs').insert({
      tenant_id: entry.tenantId,
      user_id: entry.userId ?? null,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      metadata: entry.metadata ?? null,
      ip_address: ip,
      user_agent: userAgent,
    });

    if (error) {
      console.error('[audit] write_failed');
    }
  } catch {
    console.error('[audit] write_failed');
  }
}
