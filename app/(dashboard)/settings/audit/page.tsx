import { FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { createClient } from '@/lib/supabase/server';

import { AuditLog, type AuditLogEntry } from './_components/audit-log';

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Zalogowanie',
  'auth.logout': 'Wylogowanie',
  'auth.signup': 'Rejestracja',
  'auth.password_reset_requested': 'Prośba o reset hasła',
  'auth.passkey_added': 'Dodano urządzenie do logowania biometrią',
  'auth.passkey_removed': 'Usunięto urządzenie do logowania biometrią',
  'auth.session_revoked': 'Wylogowano urządzenie na odległość',
  'auth.other_sessions_revoked': 'Wylogowano pozostałe urządzenia',
  'invoice.draft_created': 'Utworzono szkic faktury',
  'invoice.draft_updated': 'Zaktualizowano szkic faktury',
  'invoice.draft_deleted': 'Usunięto szkic faktury',
  'invoice.submit_requested': 'Wysłano fakturę do KSeF',
  'invoice.submit_succeeded': 'Faktura zaakceptowana przez KSeF',
  'invoice.submit_failed': 'Faktura odrzucona przez KSeF',
  'invoice.xml_downloaded': 'Pobrano XML faktury',
  'invoice.share_link_created': 'Utworzono link do faktury dla nabywcy',
  'invoice.share_link_revoked': 'Cofnięto link do faktury dla nabywcy',
  'invoice.resubmit_requested': 'Ponowna wysyłka faktury',
  'invoice.payment_recorded': 'Zapisano wpłatę do faktury',
  'invoice.payment_voided': 'Cofnięto wpłatę do faktury',
  'bank.statement_imported': 'Wgrano wyciąg bankowy',
  'bank.operation_confirmed': 'Potwierdzono wpłatę z wyciągu',
  'bank.operation_skipped': 'Pominięto operację z wyciągu',
  'bank.operation_undone': 'Cofnięto potwierdzenie wpłaty z wyciągu',
  'ksef.credentials_uploaded': 'Wgrano certyfikat KSeF',
  'ksef.credentials_removed': 'Usunięto certyfikat KSeF',
  'ksef.environment_changed': 'Zmiana środowiska KSeF',
  'calendar_feed.created': 'Adres kalendarza utworzony',
  'calendar_feed.regenerated': 'Adres kalendarza wymieniony',
  'calendar_feed.deleted': 'Adres kalendarza usunięty',
  'accountant.token_created': 'Dostęp dla księgowej utworzony',
  'accountant.token_revoked': 'Dostęp dla księgowej cofnięty',
  'accountant.access_used': 'Księgowa pobrała dane',
  'tenant.created': 'Utworzenie firmy w systemie',
  'tenant.updated': 'Aktualizacja firmy',
  'tenant.user_role_changed': 'Zmiana roli użytkownika',
  'tenant.ksef_verified': 'Weryfikacja KSeF (claim NIP)',
  'tenant.ksef_nip_ownership_claimed': 'Przypisanie NIP do organizacji (KSeF)',
  'retention.deletion_requested': 'Żądanie usunięcia danych',
  'retention.deletion_executed': 'Wykonano usunięcie danych',
  'accountant.expense_file_viewed': 'Księgowa otworzyła dokument kosztu',
  'accountant.expense_file_downloaded': 'Księgowa pobrała dokument kosztu',
};

/**
 * Zakładka „Dziennik zdarzeń” (plan P14, bez odpowiednika w Finorze):
 * ostatnie 200 wpisów `audit_logs` czytanych klientem z sesji (RLS).
 */
export default async function AuditPage() {
  const supabase = await createClient();
  const { data: logs, error } = await supabase
    .from('audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  const entries: AuditLogEntry[] = (logs ?? []).map((log) => ({
    id: String(log.id),
    when: formatWarsawDateTime(log.created_at as string),
    action: ACTION_LABELS[log.action as string] ?? String(log.action),
    resource:
      log.entity_type && log.entity_id
        ? `${log.entity_type}:${String(log.entity_id).slice(0, 8)}…`
        : '—',
    ip: log.ip_address != null ? String(log.ip_address) : '—',
  }));

  return (
    <FieldGroup>
      <div>
        <FieldLabel>Historia aktywności</FieldLabel>
        <FieldDescription>Pełny audit trail Twojego konta — RODO zgodność</FieldDescription>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>Nie udało się wczytać historii: {error.message}</AlertDescription>
        </Alert>
      ) : (
        <AuditLog entries={entries} />
      )}
    </FieldGroup>
  );
}
