import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ShareTargetNoticeAlert } from '@/components/expenses/share-target-notice';
import {
  parseShareTargetNotice,
  shareTargetNoticeHref,
  shareTargetNoticeText,
  type ShareTargetNotice,
} from '@/lib/expenses/share-target-notice';

/**
 * Plan skalowania, sesja 31: odmowa `/share-target` (za duży plik, limit wgrań,
 * zajęty serwer) prowadzi na Koszty z komunikatem — udostępnienie z telefonu
 * to nawigacja bez okna na toast, a pasek Flo z `?paragon=` nie jest dziś
 * nigdzie wyświetlany. Komunikat mówi, że pliku nie zapisaliśmy, i co zrobić.
 * W adresie tylko kod i liczby: obcy link nie podsunie własnego tekstu.
 */

const params = (href: string) => Object.fromEntries(new URL(href, 'https://faktway.test').searchParams);

describe('adres komunikatu', () => {
  it.each<ShareTargetNotice>([
    { kind: 'za-duze', size: 7_200_000, document: 'zdjecie' },
    { kind: 'za-duze', size: 12_000_000, document: 'pdf' },
    { kind: 'za-duze', size: 12_000_000 },
    { kind: 'za-duze' },
    { kind: 'limit', retryAfter: 125 },
    { kind: 'limit' },
    { kind: 'zajete' },
  ])('%o: adres na Koszty i z powrotem ten sam komunikat', (notice) => {
    const href = shareTargetNoticeHref(notice);
    expect(href.startsWith('/expenses?udostepnienie=')).toBe(true);
    expect(parseShareTargetNotice(params(href))).toEqual(notice.kind === 'za-duze'
      ? { size: undefined, document: undefined, ...notice }
      : notice.kind === 'limit' ? { retryAfter: undefined, ...notice } : notice);
  });

  it.each([
    {},
    { udostepnienie: 'blad' },
    { udostepnienie: '<script>alert(1)</script>' },
    { udostepnienie: ['za-duze', 'limit'] },
  ])('nieznany albo podwójny kod (%o) → bez komunikatu', (search) => {
    expect(parseShareTargetNotice(search)).toBeNull();
  });

  it.each(['-5', '1.5', '1e9', 'abc', '0', '9999999999999', ''])('rozmiar „%s” spoza zakresu jest pomijany', (rozmiar) => {
    expect(parseShareTargetNotice({ udostepnienie: 'za-duze', rozmiar, rodzaj: 'zdjecie' })).toEqual({
      kind: 'za-duze',
      size: undefined,
      document: 'zdjecie',
    });
  });

  it('nieznany rodzaj dokumentu jest pomijany, a sekundy ponad dobę też', () => {
    expect(parseShareTargetNotice({ udostepnienie: 'za-duze', rodzaj: 'exe' })).toMatchObject({ document: undefined });
    expect(parseShareTargetNotice({ udostepnienie: 'limit', za: '999999' })).toEqual({ kind: 'limit', retryAfter: undefined });
  });
});

describe('treść komunikatu', () => {
  it('zdjęcie ponad próg odczytu: rozmiar, limit 7 MB, droga przez „Dodaj wydatek”', () => {
    const { title, body } = shareTargetNoticeText({ kind: 'za-duze', size: 7_200_000, document: 'zdjecie' });
    expect(title).toContain('nie zapisaliśmy');
    expect(body).toContain('7,2 MB');
    expect(body).toContain('najwyżej 7 MB');
    expect(body).toContain('Dodaj wydatek');
  });

  it('PDF ponad 10 MB', () => {
    const { title, body } = shareTargetNoticeText({ kind: 'za-duze', size: 12_000_000, document: 'pdf' });
    expect(title).toMatch(/^PDF/);
    expect(body).toContain('12,0 MB');
    expect(body).toContain('najwyżej 10 MB');
  });

  it('rodzaj nieznany (odmowa po samym rozmiarze żądania): oba limity', () => {
    const { body } = shareTargetNoticeText({ kind: 'za-duze', size: 12_000_000 });
    expect(body).toContain('10 MB (PDF)');
    expect(body).toContain('7 MB (zdjęcie)');
  });

  it('bez rozmiaru w adresie zdanie dalej ma sens', () => {
    expect(shareTargetNoticeText({ kind: 'za-duze', document: 'zdjecie' }).body).toMatch(/^Udostępnione zdjęcie przekracza 7 MB/);
    expect(shareTargetNoticeText({ kind: 'za-duze' }).body).toMatch(/^Udostępniony plik przekracza limit/);
  });

  it('limit wgrań: minuty w górę; bez sekund — „za kilka minut”', () => {
    expect(shareTargetNoticeText({ kind: 'limit', retryAfter: 125 }).body).toContain('za 3 min');
    expect(shareTargetNoticeText({ kind: 'limit', retryAfter: 10 }).body).toContain('za 1 min');
    expect(shareTargetNoticeText({ kind: 'limit' }).body).toContain('za kilka minut');
  });

  it('zajęty serwer: ponów albo dodaj tutaj', () => {
    const { body } = shareTargetNoticeText({ kind: 'zajete' });
    expect(body).toContain('nie zapisaliśmy');
    expect(body).toContain('Dodaj wydatek');
  });

  it('komponent pokazuje tytuł i treść jako alert', () => {
    const html = renderToStaticMarkup(<ShareTargetNoticeAlert notice={{ kind: 'za-duze', size: 7_200_000, document: 'zdjecie' }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Zdjęcie jest za duże');
    expect(html).toContain('7,2 MB');
  });
});

function findNotice(node: ReactNode): ShareTargetNotice | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNotice(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as { notice?: ShareTargetNotice; children?: ReactNode };
  if (node.type === ShareTargetNoticeAlert) return props.notice ?? null;
  return findNotice(props.children);
}

// Pierwszy import strony /expenses (cały panel Kosztów) trwa kilka sekund.
describe('strona /expenses', { timeout: 30_000 }, () => {
  async function page(search: Record<string, string>) {
    vi.doMock('@/lib/supabase/page-context', () => ({
      getPageContext: async () => {
        const chain: Record<string, unknown> = {};
        for (const m of ['from', 'select', 'eq', 'order', 'gte', 'lte']) chain[m] = () => chain;
        chain.limit = async () => ({ data: [], error: null });
        return { supabase: chain, tenantId: 'ten-1' };
      },
    }));
    const { default: ExpensesPage } = await import('@/app/(dashboard)/(koszty)/expenses/page');
    return ExpensesPage({ searchParams: Promise.resolve(search) });
  }

  it('?udostepnienie=za-duze pokazuje komunikat nad tabelą', async () => {
    const tree = await page({ udostepnienie: 'za-duze', rodzaj: 'zdjecie', rozmiar: '7200000' });
    expect(findNotice(tree)).toEqual({ kind: 'za-duze', size: 7_200_000, document: 'zdjecie' });
  });

  it('bez parametru — bez komunikatu', async () => {
    expect(findNotice(await page({}))).toBeNull();
    expect(findNotice(await page({ miesiac: '2026-02' }))).toBeNull();
  });
});
