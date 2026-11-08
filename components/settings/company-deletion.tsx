import { RiMailSendLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { FieldDescription, FieldLabel } from '@/components/ui/field';
import { SUPPORT_EMAIL } from '@/lib/site';

/**
 * Usunięcie firmy (organizacji) — wyłącznie przez pomoc techniczną.
 *
 * Aplikacja nie umie firmy wyłączyć ani usunąć: flag `tenants.deleted_at` /
 * `is_active` nie sprawdza logowanie, RLS (`is_member_of`,
 * `get_current_tenant_id`) ani żaden job, a subskrypcji nikt nie anuluje.
 * Do 15.10.2026 był tu formularz z NIP wołający akcję, która stawiała te
 * flagi i wylogowywała; #271 zamienił ją w odmowę z adresem pomocy, a 22.10
 * formularz i akcję usunęliśmy, bo prowadziły już tylko do komunikatu.
 * Zostaje instrukcja i link `mailto:` z NIP w temacie, żeby operator od razu
 * wiedział, której firmy dotyczy zlecenie.
 *
 * Teksty zgodne z regulaminem (§ 14 ust. 2 i 6) i umową powierzenia (§ 9).
 * Ścieżka operatora: `docs/support/escalation-matrix.md` („Usunięcie firmy”).
 * Konto użytkownika usuwa osobno sekcja „Twoje dane (RODO)” na tej samej
 * stronie (`lib/gdpr/deletion.ts`).
 * Test: `tests/unit/usuwanie-firmy-wstrzymane.test.tsx`.
 */

function deletionMailtoHref(tenantNip: string): string {
  const nip = tenantNip.replace(/\D/g, '');
  const subject = nip ? `Usunięcie firmy, NIP ${nip}` : 'Usunięcie firmy';
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

export function CompanyDeletion({ tenantNip, isOwner }: { tenantNip: string; isOwner: boolean }) {
  return (
    <>
      <div>
        <FieldLabel className="text-destructive">Usuń organizację (firmę)</FieldLabel>
        <FieldDescription>
          Usunięcie firmy rozwiązuje umowę. Zlecasz je przez pomoc techniczną:
          napisz na {SUPPORT_EMAIL} z adresu właściciela i podaj NIP firmy. Do
          czasu wykonania zlecenia firma i abonament działają bez zmian —
          abonament anulujesz w Ustawienia → Abonament.{' '}
          <strong>Najpierw pobierz kopię danych</strong> (Księgowość →
          Eksport). Faktury wysłane do KSeF przechowuje też Ministerstwo
          Finansów. To nie jest usunięcie Twojego konta — do tego służy sekcja
          &laquo;Twoje dane (RODO)&raquo; powyżej.
        </FieldDescription>
      </div>
      {isOwner ? (
        <div>
          <Button variant="destructive" render={<a href={deletionMailtoHref(tenantNip)} />} nativeButton={false}>
            <RiMailSendLine aria-hidden />
            Napisz do pomocy
          </Button>
        </div>
      ) : (
        <FieldDescription>
          Tylko właściciel konta może zlecić usunięcie firmy.
        </FieldDescription>
      )}
    </>
  );
}
