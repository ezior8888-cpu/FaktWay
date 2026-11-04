import type { ReactNode } from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakePostgrest } from '../helpers/fake-postgrest';
import { memoryClient } from './helpers/baza-w-pamieci';

/**
 * T2 (PLAN-PRAWDZIWE-DANE §8): zero przecieku danych przykładowych do HTML
 * strony firmy na prawdziwych danych. Strony renderowane w całości (z
 * asynchronicznymi kartami w `Suspense`) przez `prerenderToNodeStream`, na
 * kliencie zwracającym puste zbiory; szpiedzy pilnują, że atrapa
 * (`analizyDemoSupabase`) i księga przykładowa (`kpirPrzykladowe`) nie są
 * nawet wołane. Etap E1b: Analizy (sprzedaż, koszty) i KPiR; E5: Pulpit;
 * E6: Przepływy.
 */

type Proof = { verifiedAt: string | null; verifiedEnvironment: string | null };

const state = vi.hoisted(() => ({
  ctx: null as unknown as { supabase: unknown; tenantId: string; user: { id: string; email: string | null }; role: 'owner' },
  proof: null as Proof | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/analizy/sprzedaz',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => { throw new Error(`redirect ${to}`); },
}));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: async () => state.ctx }));
vi.mock('@/lib/dashboard-shell-data', async () => {
  const { hasConfiguredKsefProof } = await import('@/lib/ksef/claim-environment');
  return {
    getTenantKsefProof: async () => state.proof,
    // Stara bramka (cookie aktywnej firmy = ta sama firma co w kontekście strony).
    getDashboardActiveOrgVerified: async () =>
      hasConfiguredKsefProof(state.proof?.verifiedAt, state.proof?.verifiedEnvironment),
  };
});
vi.mock('@/lib/demo/analizy-przykladowe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/demo/analizy-przykladowe')>();
  return { ...real, analizyDemoSupabase: vi.fn(real.analizyDemoSupabase) };
});
vi.mock('@/lib/demo/kpir-przykladowe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/demo/kpir-przykladowe')>();
  return { ...real, kpirPrzykladowe: vi.fn(real.kpirPrzykladowe) };
});

const { ZNACZNIKI_PRZYKLADU } = await import('@/lib/demo/znaczniki');
const { analizyDemoSupabase } = await import('@/lib/demo/analizy-przykladowe');
const { kpirPrzykladowe } = await import('@/lib/demo/kpir-przykladowe');
const { default: SprzedazPage } = await import('@/app/(dashboard)/analizy/sprzedaz/page');
const { default: KosztyPage } = await import('@/app/(dashboard)/analizy/koszty/page');
const { default: KpirPage } = await import('@/app/(dashboard)/reports/kpir/page');
const { default: PulpitPage } = await import('@/app/(dashboard)/dashboard/page');
const { default: PrzeplywyPage } = await import('@/app/(dashboard)/przeplywy/page');

async function html(node: ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(<>{node}</>);
  let out = '';
  for await (const chunk of prelude) out += String(chunk);
  return out;
}

const params = () => Promise.resolve({});

const STRONY: Array<[string, () => Promise<ReactNode>]> = [
  ['/analizy/sprzedaz', () => SprzedazPage({ searchParams: params() })],
  ['/analizy/koszty', () => KosztyPage({ searchParams: params() })],
  ['/reports/kpir', () => KpirPage({ searchParams: params() })],
  ['/dashboard', () => PulpitPage()],
  // Przed E6 strona była synchroniczna (stałe szablonu) — `await` działa na obu.
  ['/przeplywy', async () => PrzeplywyPage()],
];

const ZWERYFIKOWANA: Proof = { verifiedAt: '2026-09-01T08:00:00Z', verifiedEnvironment: 'test' };

function znaczniki(markup: string): string[] {
  return ZNACZNIKI_PRZYKLADU.filter((z) => markup.includes(z));
}

beforeEach(() => {
  state.ctx = {
    // Pusta baza: wszystkie tabele (także `ksef_history_sync`) bez wierszy.
    supabase: memoryClient({}),
    tenantId: 'firma-a',
    user: { id: 'uzytkownik-1', email: null },
    role: 'owner',
  };
  state.proof = ZWERYFIKOWANA;
  vi.mocked(analizyDemoSupabase).mockClear();
  vi.mocked(kpirPrzykladowe).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('T2: zero przecieku przykładu w trybie prawdziwym', () => {
  it.each(STRONY)('%s — zweryfikowana firma: HTML bez znaczników przykładu, atrapa nie wołana', async (_path, page) => {
    const markup = await html(await page());
    expect(markup.length).toBeGreaterThan(500);
    expect(znaczniki(markup)).toEqual([]);
    expect(analizyDemoSupabase).not.toHaveBeenCalled();
    expect(kpirPrzykladowe).not.toHaveBeenCalled();
  });

  it.each([...STRONY.slice(0, 2), STRONY[3]!, STRONY[4]!])("%s — G'' (brak KSEF_ENV): prawdziwe dane, nie przykład u każdej firmy", async (_path, page) => {
    vi.stubEnv('KSEF_ENV', '');
    state.ctx.supabase = fakePostgrest({});
    const markup = await html(await page());
    expect(znaczniki(markup)).toEqual([]);
    expect(analizyDemoSupabase).not.toHaveBeenCalled();
  });

  it("/reports/kpir — G'' (brak KSEF_ENV): bez księgi przykładowej", async () => {
    vi.stubEnv('KSEF_ENV', '');
    // Brak środowiska wywraca KPiR do `error.tsx` (strona bez try/catch) — ważne, że nie do przykładu.
    const markup = await KpirPage({ searchParams: params() }).then((p) => html(p), () => '');
    expect(znaczniki(markup)).toEqual([]);
    expect(kpirPrzykladowe).not.toHaveBeenCalled();
  });
});

describe('T2: kontrola znaczników — przed weryfikacją przykład jest widoczny', () => {
  it.each(STRONY)('%s — niezweryfikowana firma: HTML ma znaczniki przykładu', async (_path, page) => {
    state.proof = { verifiedAt: null, verifiedEnvironment: null };
    const markup = await html(await page());
    expect(znaczniki(markup).length).toBeGreaterThan(0);
  });
});

describe('E12 (D-P): plakietka „Dane przykładowe” na Pulpicie i Przepływach', () => {
  const OBA: Array<[string, () => Promise<ReactNode>]> = [STRONY[3]!, STRONY[4]!];

  it.each(OBA)('%s — przed weryfikacją KSeF plakietka jest w nagłówku', async (_path, page) => {
    state.proof = { verifiedAt: null, verifiedEnvironment: null };
    const markup = await html(await page());
    expect(markup).toContain('Dane przykładowe');
  });

  it.each(OBA)('%s — zweryfikowana firma: bez plakietki', async (_path, page) => {
    const markup = await html(await page());
    expect(markup).not.toContain('Dane przykładowe');
  });

  it.each(OBA)('%s — zweryfikowana, historia się pobiera (synchronizacja): bez plakietki', async (_path, page) => {
    state.ctx.supabase = memoryClient({
      ksef_history_sync: [{
        tenant_id: 'firma-a',
        environment: 'test',
        direction: 'outgoing',
        created_at: new Date().toISOString(),
        backfill_completed_at: null,
        client_paused_at: null,
        last_error_code: null,
      }],
    });
    const markup = await html(await page());
    expect(markup).toContain('Pobieramy faktury z KSeF');
    expect(markup).not.toContain('Dane przykładowe');
  });

  it.each(OBA)("%s — G'' (brak KSEF_ENV): bez plakietki", async (_path, page) => {
    vi.stubEnv('KSEF_ENV', '');
    state.ctx.supabase = fakePostgrest({});
    const markup = await html(await page());
    expect(markup).not.toContain('Dane przykładowe');
  });
});
