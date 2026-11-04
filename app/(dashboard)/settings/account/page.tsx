import { CookieSettings } from '@/components/legal/cookie-settings';
import { CompanyDeletion } from '@/components/settings/company-deletion';
import { FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import { getPageContext } from '@/lib/supabase/page-context';
import { getActiveGdprRequest } from '@/lib/gdpr/deletion';
import { GdprSection } from './_components/gdpr-section';

export const dynamic = 'force-dynamic';

/**
 * Zakładka „Konto i dane (RODO)” = Privacy & Data z Finory
 * (`views/settings/privacy`): eksport danych (art. 15), usunięcie konta
 * (art. 17), zgoda na analitykę i, jedyne miejsce w aplikacji, usunięcie firmy.
 */
export default async function AccountSettingsPage() {
  const { supabase, tenantId, role, user } = await getPageContext();
  const gdprRequest = await getActiveGdprRequest(supabase, user.id);

  const { data: tenant } = await supabase
    .from('tenants')
    .select('nip')
    .eq('id', tenantId)
    .maybeSingle();

  const nip = String(tenant?.nip ?? '');
  const isOwner = role === 'owner';

  return (
    <FieldGroup>
      <div>
        <FieldLabel>Twoje dane (RODO)</FieldLabel>
        <FieldDescription>
          Prawo dostępu (art. 15) i prawo do bycia zapomnianym (art. 17).
        </FieldDescription>
      </div>

      <GdprSection initialRequest={gdprRequest ? {
        status: gdprRequest.status,
        scheduledFor: new Date(gdprRequest.scheduled_for).toLocaleDateString('pl-PL', {
          year: 'numeric', month: 'long', day: 'numeric',
        }),
      } : null} />

      <Separator />

      {/* Odwołanie zgody ma być tak samo łatwe jak jej udzielenie (art. 7 ust. 3 RODO). */}
      <div className="flex flex-col gap-3">
        <div>
          <FieldLabel>Analityka</FieldLabel>
          <FieldDescription>
            Statystyki użycia i to, skąd do nas trafiłeś. Decyzja obowiązuje na Twoim koncie na każdym urządzeniu.
            Wyłączenie działa od razu i usuwa zapisane źródło wejścia.
          </FieldDescription>
        </div>
        <CookieSettings />
      </div>

      <Separator />

      {/* Usunięcie firmy idzie przez pomoc techniczną: instrukcja i link
          mailto, bez formularza (aplikacja nie umie firmy wyłączyć ani
          usunąć — szczegóły w komponencie). */}
      <CompanyDeletion tenantNip={nip} isOwner={isOwner} />
    </FieldGroup>
  );
}
