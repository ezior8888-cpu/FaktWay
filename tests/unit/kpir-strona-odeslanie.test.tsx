import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryClient, type MemoryTables } from './helpers/baza-w-pamieci';

/**
 * Odesłanie ze starego raportu `/reports/kpir` do księgi modułu (plan
 * księgowości JDG, K8, D20) na prawdziwej ścieżce strony: prawdziwy tryb
 * danych, wyłącznik i profil podatkowy na bazie w pamięci; atrapy tylko dla
 * dowodu KSeF firmy i globalnej flagi (odczyty bazy spoza sesji klienta).
 *
 * Uwaga ze sprawdzenia w przeglądarce 8.11.2026: firma w pilotażu bez
 * weryfikacji KSeF widziała księgę przykładową bez odesłania, bo strona
 * kończyła się w trybie przykładowym przed odczytem odesłania. Księga modułu
 * (`/reports/ewidencja`) liczy prawdziwe dane bez względu na weryfikację,
 * więc odesłanie należy się w obu trybach.
 */

type Proof = { verifiedAt: string | null; verifiedEnvironment: string | null };

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  proof: null as Proof | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/reports/kpir',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({
    supabase: memoryClient(state.tables as MemoryTables),
    tenantId: 'firma-a',
    user: { id: 'uzytkownik-1', email: null },
    role: 'owner',
  }),
}));
vi.mock('@/lib/dashboard-shell-data', () => ({ getTenantKsefProof: async () => state.proof }));
// Globalny stop księgowości czyta się rozstrzygająco (F11-B6, `getGlobalFlagForExecution`).
vi.mock('@/lib/feature-flags/global-flags', () => ({
  getGlobalFlag: async () => false,
  getGlobalFlagForExecution: async () => false,
}));

const { default: KpirPage } = await import('@/app/(dashboard)/reports/kpir/page');
const { ZNACZNIKI_PRZYKLADU } = await import('@/lib/demo/znaczniki');

const NIEZWERYFIKOWANA: Proof = { verifiedAt: null, verifiedEnvironment: null };
const ZWERYFIKOWANA: Proof = { verifiedAt: '2026-09-01T08:00:00Z', verifiedEnvironment: 'test' };

const PILOTAZ = [{ tenant_id: 'firma-a', ksiegowosc_enabled: true }];
const SKALA = [{
  tenant_id: 'firma-a', id: 'p1', valid_from: '2026-01-01', forma: 'skala', stawka_domyslna: null,
  zus_etap: 'pelny', zus_od: null, chorobowe: false, nrs_zus: null, najem: false,
}];

const strona = async () => renderToStaticMarkup(await KpirPage({ searchParams: Promise.resolve({ month: '9', year: '2026' }) }));
const przyklad = (html: string) => ZNACZNIKI_PRZYKLADU.filter((z) => html.includes(z));

beforeEach(() => {
  state.tables = { tenant_feature_flags: PILOTAZ, tax_profiles: SKALA };
  state.proof = NIEZWERYFIKOWANA;
});

describe('odesłanie z /reports/kpir do księgi modułu (K8, D20)', () => {
  it('firma w pilotażu przed weryfikacją KSeF: księga przykładowa i odesłanie za ten sam miesiąc', async () => {
    const html = await strona();
    expect(przyklad(html).length).toBeGreaterThan(0);
    expect(html).toContain('Księga w module księgowości');
    expect(html).toContain('href="/reports/ewidencja?month=9&amp;year=2026"');
  });

  it('firma w pilotażu po weryfikacji KSeF: odesłanie nad raportem z prawdziwymi danymi', async () => {
    state.proof = ZWERYFIKOWANA;
    const html = await strona();
    expect(przyklad(html)).toEqual([]);
    expect(html).toContain('Księga w module księgowości');
    expect(html).toContain('href="/reports/ewidencja?month=9&amp;year=2026"');
  });

  it('firma poza pilotażem przed weryfikacją: księga przykładowa bez odesłania (raport bez zmian)', async () => {
    state.tables = { tax_profiles: SKALA };
    const html = await strona();
    expect(przyklad(html).length).toBeGreaterThan(0);
    expect(html).not.toContain('Księga w module księgowości');
  });
});
