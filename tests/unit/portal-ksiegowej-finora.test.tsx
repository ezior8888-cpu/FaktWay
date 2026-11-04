import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ load: vi.fn(), notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }) }));
vi.mock('next/navigation', () => ({ notFound: st.notFound, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/accountant/load-accountant-portal', () => ({ loadAccountantPortal: st.load }));
vi.mock('@/components/exports/accountant-export-buttons', () => ({ AccountantExportButtons: () => 'PRZYCISKI-EKSPORTU' }));

import { metadata } from '@/app/accountant/layout';
import AccountantPortalPage from '@/app/accountant/[token]/page';

/**
 * Portal księgowej (E8): tylko Card i Table Finory, bez szkła; token zostaje
 * poza nagłówkiem Referer (`referrer: 'no-referrer'` w layoucie).
 */

function portal(level: string) {
  return {
    access: { id: 'a', tenant_id: 'ten-1', accountant_name: 'Anna', accountant_email: 'a@example.test', access_level: level, expires_at: '2026-12-31T23:30:00Z' },
    tenant: { name: 'Moja Firma', nip: '5260001246' },
    invoices: [{ id: 'i1', internal_number: 'FV/1', issue_date: '2026-09-10', gross_total: 1230, ksef_status: 'accepted', direction: 'outgoing', xml_storage_path: 'x/1.xml' }],
  };
}

describe('portal księgowej — wygląd Finory', () => {
  it('nagłówek, dostęp z pobieraniem, eksport i lista w kartach Finory', async () => {
    st.load.mockResolvedValue(portal('download'));
    const html = renderToStaticMarkup(await AccountantPortalPage({ params: Promise.resolve({ token: 'tok%20en' }) }));
    expect(st.load).toHaveBeenCalledWith('tok en');
    for (const text of ['Moja Firma', 'NIP: 5260001246', 'Z pobieraniem', 'Anna', 'Pobierz dane księgowe',
      'PRZYCISKI-EKSPORTU', 'FV/1', '1230,00 zł', '10.09.2026', 'Przyjęta w KSeF', 'Powered by FaktWay']) {
      expect(html).toContain(text);
    }
    // Wygasa w dniu polskim: 31.12 23:30 UTC to już 1 stycznia 00:30 w Warszawie.
    expect(html).toMatch(/Wygasa: (<!-- -->)?01\.01\.2027/);
    expect(html).toContain('data-slot="card"');
    expect(html).toContain('data-slot="table"');
    expect(html).not.toContain('backdrop-blur');
    expect(html).not.toContain('rgba(15,10,30');
    expect(html).not.toContain('bg-mesh-surface');
  });

  it.each([[1, '1 pozycja'], [2, '2 pozycje'], [5, '5 pozycji'], [12, '12 pozycji'], [22, '22 pozycje']])(
    'opis listy: %i dokumentów → „%s”', async (count, text) => {
      const data = portal('download');
      data.invoices = Array.from({ length: count }, (_, i) => ({ ...data.invoices[0], id: `i${i}`, internal_number: `FV/${i}` }));
      st.load.mockResolvedValue(data);
      const html = renderToStaticMarkup(await AccountantPortalPage({ params: Promise.resolve({ token: 't' }) }));
      expect(html).toMatch(new RegExp(`${text.split(' ')[0]} (<!-- -->)?${text.split(' ')[1]} (<!-- -->)?· najnowsze na górze`));
    });

  it('tylko podgląd: bez eksportu i bez „Pobierz XML”', async () => {
    st.load.mockResolvedValue(portal('read_only'));
    const html = renderToStaticMarkup(await AccountantPortalPage({ params: Promise.resolve({ token: 't' }) }));
    expect(html).toContain('Tylko podgląd');
    expect(html).not.toContain('PRZYCISKI-EKSPORTU');
    expect(html).not.toContain('Pobierz XML');
  });

  it('nieważny token → notFound; layout bez Referer i bez indeksowania', async () => {
    st.load.mockResolvedValue(null);
    await expect(AccountantPortalPage({ params: Promise.resolve({ token: 'x' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(metadata.referrer).toBe('no-referrer');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
