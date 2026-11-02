import { headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/server';

async function readRequestClientHints(): Promise<{
  ip: string | null;
  userAgent: string | null;
}> {
  try {
    const hdrs = await headers();
    const ip =
      hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      hdrs.get('x-real-ip') ??
      null;
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
  | 'invoice.resubmit_requested'
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
  // Faza 23 sekcja 3 — audyt każdej interakcji z KSeF API.
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
  | 'accountant.token_created'
  | 'accountant.token_revoked'
  | 'accountant.access_used'
  | 'accountant.portal_export'
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
  | 'legal.email_consent_withdrawn';

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
