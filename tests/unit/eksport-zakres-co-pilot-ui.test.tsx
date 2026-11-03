import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/app/actions/exports', () => ({ triggerCoPilotNowAction: vi.fn(), updateAccountantSettingsAction: vi.fn() }));

import { CoPilotSettingsForm, type ExportJobPreviewRow } from '@/components/exports/co-pilot-settings-form';

/**
 * FIR-01 (27.10.2026): pola „Co dołączać do paczki” nie okrajają KPiR, więc
 * ekran to mówi. KPiR czyta z faktur tylko sprzedaż (koszty z wydatków), więc
 * `invoices_count` przy KPiR nie liczy kosztów — lista paczek nie pokazuje
 * wtedy „0 faktur” przy pliku pełnym kosztów (jak historia eksportów).
 */

const paczka = (o: Partial<ExportJobPreviewRow>): ExportJobPreviewRow => ({
  id: 'job-1', format: 'kpir_excel', status: 'completed', period_start: '2026-09-01', period_end: '2026-09-30',
  created_at: '2026-10-05T06:00:00Z', invoices_count: 0, emailed_at: '2026-10-05T06:05:00Z',
  ...o,
} as ExportJobPreviewRow);

const render = (recentJobs: ExportJobPreviewRow[]) =>
  renderToStaticMarkup(<CoPilotSettingsForm initialSettings={null} recentJobs={recentJobs} />);

describe('Co-Pilot: zakres paczki na ekranie (FIR-01)', () => {
  it('pod „Co dołączać do paczki” — KPiR zawsze cała, pola dla CSV', () => {
    const html = render([]);
    expect(html).toContain('KPiR zawsze ma całą sprzedaż (z zaliczkami, rozliczeniami i korektami) i koszty');
    expect(html).toContain('Pola niżej dotyczą pliku CSV i JPK_FA.');
    // Do filtra `.neq('invoice_kind','correction')`: bez korekt wypadają też ZAL i ROZ.
    expect(html).toContain('Bez „Faktur korygujących” oba pliki mają tylko zwykłe faktury, bez zaliczek i rozliczeń.');
    expect(html).not.toContain('ustawiają plik CSV i korekty');
  });

  it('KPiR bez liczby faktur; CSV z liczbą', () => {
    const html = render([
      paczka({ id: 'kpir', format: 'kpir_excel', invoices_count: 0 }),
      paczka({ id: 'csv', format: 'csv_universal', invoices_count: 3 }),
    ]);
    expect(html).not.toContain('0 faktur');
    expect(html).toContain('3 faktury • wysłano');
    expect(html.match(/wysłano/g)).toHaveLength(2);
  });

  it('format spoza reguły: wiersz z licznikiem, strona ustawień się nie wywraca', () => {
    const html = render([paczka({ id: 'nowy', format: 'nowy_format' as ExportJobPreviewRow['format'], invoices_count: 2 })]);
    expect(html).toContain('NOWY FORMAT');
    expect(html).toContain('2 faktury • wysłano');
  });
});
