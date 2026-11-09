import {
  portalPage,
  publicPortalAccess,
  recordPortalVisit,
  resolvePortalAccess,
  type PortalAccess,
  type PortalPage,
} from '@/lib/accountant/portal-access';
import { createAdminClient } from '@/lib/supabase/server';

export interface AccountantPortalData {
  access: PortalAccess;
  tenant: { name: string; nip: string };
  /** Dokumenty bieżącej strony listy (najnowsze na górze). */
  invoices: Array<{
    id: string;
    internal_number: string | null;
    issue_date: string;
    gross_total: number | null;
    /** Waluta faktury (`null` jak w liście faktur aplikacji: złote). Faktura zakupu z KSeF bywa w walucie obcej. */
    currency?: string | null;
    ksef_status: string | null;
    /** `outgoing` = sprzedaż, `incoming` = koszt. */
    direction: string | null;
    /** XML w magazynie — bez niego nie ma czego pobrać. */
    xml_storage_path: string | null;
  }>;
  /** Strona listy (krok 6.2: strony po 50 zamiast jednej listy do 100). */
  invoicesPage: PortalPage;
  /** Odczyt listy się nie udał: strona pokazuje komunikat, nie „brak dokumentów”. */
  invoicesError: boolean;
}

/**
 * Dokumenty księgowe dla księgowej (F-063): przyjęte w KSeF (sprzedaż
 * i koszty) oraz wystawione w trybie offline, czekające na KSeF. Szkice,
 * faktury w kolejce i odrzucone nie są dokumentami księgowymi.
 */
export const ACCOUNTANT_PORTAL_STATUSES = ['accepted', 'received', 'offline_queued'] as const;

/**
 * Weryfikuje token (hash) i zwraca dane do widoku portalu księgowej.
 * Używa service_role — wyłącznie po stronie serwera, bez sesji użytkownika.
 * Lista strona po stronie: najpierw liczba dokumentów, potem wiersze strony
 * (strona za końcem listy to ostatnia strona).
 */
export async function loadAccountantPortal(
  rawToken: string,
  options: { page?: number } = {},
): Promise<AccountantPortalData | null> {
  const admin = createAdminClient();
  const access = await resolvePortalAccess(admin, rawToken);
  if (!access) return null;

  const { data: tenant } = await admin
    .from('tenants')
    .select('name, nip')
    .eq('id', access.tenant_id)
    .maybeSingle();

  if (!tenant?.nip) return null;

  const counted = await admin
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', access.tenant_id)
    .in('ksef_status', [...ACCOUNTANT_PORTAL_STATUSES]);

  const page = portalPage(counted.count ?? 0, options.page ?? 1);
  let invoices: AccountantPortalData['invoices'] = [];
  let invoicesError = Boolean(counted.error) || counted.count == null;
  if (!invoicesError) {
    const { data, error } = await admin
      .from('invoices')
      .select('id, internal_number, issue_date, gross_total, currency, ksef_status, direction, xml_storage_path')
      .eq('tenant_id', access.tenant_id)
      .in('ksef_status', [...ACCOUNTANT_PORTAL_STATUSES])
      .order('issue_date', { ascending: false })
      .order('id', { ascending: true })
      .range(page.from, page.to);
    invoicesError = Boolean(error) || !data;
    invoices = (data ?? []) as AccountantPortalData['invoices'];
  }

  await recordPortalVisit(admin, access);

  return {
    access: publicPortalAccess(access),
    tenant: {
      name: tenant.name as string,
      nip: tenant.nip as string,
    },
    invoices,
    invoicesPage: { page: page.page, pages: page.pages, total: page.total, pageSize: page.pageSize },
    invoicesError,
  };
}
