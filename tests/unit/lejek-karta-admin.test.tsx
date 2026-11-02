import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Karta lejka w /admin (FAKTWAY-1-0, sekcja 3 pkt 7): liczby z własnej bazy,
 * niezależne od PostHoga i zgód; odczyt serwisowy dopiero po `requireAdmin()`.
 * SQL lejka sprawdza tests/rls-lejek-analityka.test.ts.
 */

const h = vi.hoisted(() => ({ requireAdmin: vi.fn(), rpc: vi.fn(), order: [] as string[] }));

vi.mock('@/lib/auth/admin-guard', () => ({ requireAdmin: h.requireAdmin }));
vi.mock('@/lib/analytics/platform-metrics', () => ({ collectPlatformOverviewMetrics: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));

import { FunnelCard } from '@/app/admin/_components/funnel-card';
import { getAdminFunnelWeekly } from '@/lib/admin/metrics';
import type { FunnelWeekRow } from '@/lib/observability/business-metrics';

const row = (over: Partial<FunnelWeekRow>): FunnelWeekRow => ({
  weekStart: '2026-10-26', source: 'all', newTenants: 0, ksefConnected: 0,
  firstInvoice: 0, trialStarted: 0, paying: 0, churned: 0, ...over,
});

const ROWS: FunnelWeekRow[] = [
  row({ weekStart: '2026-10-26', newTenants: 10, ksefConnected: 8, firstInvoice: 6, trialStarted: 5, paying: 2, churned: 1 }),
  row({ weekStart: '2026-10-19', newTenants: 10, ksefConnected: 4, firstInvoice: 2, trialStarted: 3, paying: 2, churned: 3 }),
  row({ weekStart: '2026-10-12' }),
  row({ weekStart: '2026-10-26', source: 'google_ads', newTenants: 3, ksefConnected: 2, firstInvoice: 1, trialStarted: 1, paying: 1 }),
  row({ weekStart: '2026-10-19', source: 'google_ads', newTenants: 1, paying: 1 }),
  row({ weekStart: '2026-10-26', source: 'tiktok', newTenants: 2, churned: 1 }),
];

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('karta lejka', () => {
  const html = renderToStaticMarkup(<FunnelCard rows={ROWS} />);
  const plain = text(html);

  it('podsumowanie okresu: każdy krok i udział w nowych firmach', () => {
    expect(plain).toContain('Nowe firmy 20');
    expect(plain).toContain('Podłączony KSeF 12');
    expect(plain).toContain('60%');
    expect(plain).toContain('Pierwsza faktura 8');
    expect(plain).toContain('40%');
    expect(plain).toContain('Próba 8');
    expect(plain).toContain('Płacący 4');
    expect(plain).toContain('20%');
    expect(plain).toContain('Odeszli 4');
  });

  it('tabela tygodni: daty od najnowszej, także tydzień bez firm', () => {
    expect(plain.indexOf('26.10')).toBeLessThan(plain.indexOf('19.10'));
    expect(plain).toContain('12.10');
  });

  it('źródła tylko z rzędów kanałów, zsumowane po tygodniach, z zaznaczeniem, że to firmy ze zgodą', () => {
    expect(plain).toMatch(/Reklamy Google 4 2 1 1 2 0/);
    expect(plain).toMatch(/TikTok 2 0 0 0 0 1/);
    expect(plain).toMatch(/tylko firmy, których właściciel zgodził się na analitykę/);
    expect(plain).not.toContain('YouTube');
  });

  it('bez firm ze zgodą: tekst zamiast pustej tabeli źródeł', () => {
    const noSources = text(renderToStaticMarkup(<FunnelCard rows={ROWS.filter((r) => r.source === 'all')} />));
    expect(noSources).toContain('Żadna firma z tego okresu nie ma jeszcze źródła');
  });

  it('dzielenie przez zero: pusty okres pokazuje 0, nie NaN', () => {
    const empty = text(renderToStaticMarkup(<FunnelCard rows={[row({})]} />));
    expect(empty).not.toContain('NaN');
    expect(empty).toContain('Nowe firmy 0');
  });

  it('brak danych (stara baza, błąd RPC): komunikat zamiast awarii panelu', () => {
    const missing = text(renderToStaticMarkup(<FunnelCard rows={null} />));
    expect(missing).toContain('Lejek chwilowo niedostępny');
  });

  it('czytelna przy 390 px: tabele o stałej szerokości, bez przewijania w bok', () => {
    expect(html).toContain('table-fixed');
    expect(html).toContain('w-full');
    expect(html).not.toContain('overflow-x-auto');
    expect(html).not.toMatch(/min-w-\[/);
  });

  it('tekst bez długich myślników', () => {
    expect(plain).not.toMatch(/[—–]/);
  });
});

describe('odczyt danych karty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.order.length = 0;
    h.requireAdmin.mockImplementation(async () => { h.order.push('requireAdmin'); });
    h.rpc.mockImplementation(async (fn: string, args: unknown) => {
      h.order.push(fn);
      expect(args).toEqual({ p_weeks: 12 });
      return {
        data: [{
          week_start: '2026-10-26', source: 'all', new_tenants: 10, ksef_connected: 8,
          first_invoice: 6, trial_started: 5, paying: 2, churned: 1,
        }],
        error: null,
      };
    });
  });

  it('najpierw autoryzacja, potem klucz serwisowy', async () => {
    await expect(getAdminFunnelWeekly()).resolves.toEqual([{
      weekStart: '2026-10-26', source: 'all', newTenants: 10, ksefConnected: 8,
      firstInvoice: 6, trialStarted: 5, paying: 2, churned: 1,
    }]);
    expect(h.order).toEqual(['requireAdmin', 'admin_funnel_weekly']);
  });

  it('brak uprawnień: RPC nie rusza', async () => {
    h.requireAdmin.mockRejectedValue(new Error('NEXT_NOT_FOUND'));
    await expect(getAdminFunnelWeekly()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('błąd RPC nie udaje zer', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'brak funkcji' } });
    await expect(getAdminFunnelWeekly()).rejects.toThrow();
  });
});
