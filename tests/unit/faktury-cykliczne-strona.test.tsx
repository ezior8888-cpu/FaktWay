import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan Finora N1: `/invoices/new/regular?cykliczna=<id>` („Wystaw teraz”)
 * i `?wzor=<id>` („Duplikuj”). Pozycja tylko wypełnia formularz — nic nie
 * zapisuje. Nieznane, obce albo wstrzymane id: pusty formularz z komunikatem.
 */

const POS = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
const TPL = '7f1c2d3e-4b5a-4c6d-8e7f-901234567890';

const m = vi.hoisted(() => ({
  formProps: [] as Array<Record<string, unknown>>,
  prefillFromInvoice: vi.fn(),
  getRecurring: vi.fn(),
}));

vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: vi.fn().mockResolvedValue({ supabase: {}, tenantId: 'tenant-a' }),
}));
vi.mock('@/components/invoices/actions', () => ({
  prefillFromLastInvoiceAction: vi.fn().mockResolvedValue({ contractorName: 'Ostatni', values: {} }),
  prefillFromInvoiceAction: m.prefillFromInvoice,
}));
vi.mock('@/lib/invoices/recurring/queries', () => ({ getRecurringInvoice: m.getRecurring }));
vi.mock('@/lib/invoices/vat-exemption', () => ({ readTenantVatExemption: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/invoices/next-number', () => ({
  suggestNextInvoiceNumberForTenant: vi.fn().mockResolvedValue('FV/1/10/2026'),
}));
vi.mock('@/lib/invoices/load-tenant-seller', () => ({ loadTenantSellerForForms: vi.fn().mockResolvedValue(null) }));
vi.mock('@/components/invoices/invoice-form', () => ({
  InvoiceForm: (props: Record<string, unknown>) => {
    m.formProps.push(props);
    return null;
  },
}));

import NewRegularInvoicePage from '@/app/(dashboard)/invoices/new/regular/page';

const podklad = {
  invoiceId: TPL,
  contractorName: 'Klient',
  sourceNumber: 'FV/7/09/2026',
  values: { buyerName: 'Klient', internalNumber: 'FV/1/10/2026', issueDate: '2026-10-20' },
};

function pozycja(extra: Record<string, unknown> = {}) {
  return {
    id: POS, tenant_id: 'tenant-a', template_invoice_id: TPL, name: 'Abonament', frequency: 'monthly',
    day_of_month: 10, next_run_date: '2026-11-10', active: true, ...extra,
  };
}

async function render(params: Record<string, string>) {
  return renderToStaticMarkup(await NewRegularInvoicePage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  m.formProps.length = 0;
  m.prefillFromInvoice.mockReset().mockResolvedValue(podklad);
  m.getRecurring.mockReset().mockResolvedValue(pozycja());
});

describe('?cykliczna=<id>', () => {
  it('aktywna pozycja: podkład wzoru, ukryte pole pozycji, bez banera ostatniej faktury', async () => {
    const html = await render({ cykliczna: POS });
    expect(m.getRecurring).toHaveBeenCalledWith({}, 'tenant-a', POS);
    expect(m.prefillFromInvoice).toHaveBeenCalledWith(TPL);
    expect(m.formProps.at(-1)).toMatchObject({
      initialValues: podklad.values,
      recurringInvoiceId: POS,
      // Okres z banera idzie do formularza — zapis porówna go z bieżącą pozycją (C3).
      recurringPeriod: '2026-11',
      prefill: null,
      suggestedNumber: 'FV/1/10/2026',
    });
    expect(html).toContain('Faktura cykliczna „Abonament” — listopad 2026');
    expect(html).toContain('FV/7/09/2026');
  });

  it('wstrzymana: pusty formularz z komunikatem, bez pozycji', async () => {
    m.getRecurring.mockResolvedValue(pozycja({ active: false }));
    const html = await render({ cykliczna: POS });
    expect(m.prefillFromInvoice).not.toHaveBeenCalled();
    expect(m.formProps.at(-1)).not.toHaveProperty('recurringInvoiceId');
    expect(m.formProps.at(-1)).not.toHaveProperty('initialValues');
    expect(html).toContain('Faktura cykliczna „Abonament” jest wstrzymana');
  });

  it.each([
    ['nieznana albo obca (RLS)', POS],
    ['nie-uuid', 'abc'],
  ])('%s: pusty formularz z komunikatem, nie błąd strony', async (_opis, id) => {
    m.getRecurring.mockResolvedValue(null);
    const html = await render({ cykliczna: id });
    expect(m.formProps.at(-1)).not.toHaveProperty('recurringInvoiceId');
    expect(html).toContain('Nie znaleziono faktury cyklicznej');
  });

  it('co kwartał: okres z banera w formacie kwartału', async () => {
    m.getRecurring.mockResolvedValue(pozycja({ frequency: 'quarterly', next_run_date: '2027-01-10' }));
    const html = await render({ cykliczna: POS });
    expect(m.formProps.at(-1)).toMatchObject({ recurringInvoiceId: POS, recurringPeriod: '2027-Q1' });
    expect(html).toContain('I kwartał 2027');
  });

  it('wzór nie do odczytania: pusty formularz z wykonalnym komunikatem i linkiem do listy (C8)', async () => {
    m.prefillFromInvoice.mockResolvedValue(null);
    const html = await render({ cykliczna: POS });
    expect(m.formProps.at(-1)).not.toHaveProperty('recurringInvoiceId');
    expect(m.formProps.at(-1)).not.toHaveProperty('recurringPeriod');
    expect(html).toContain('Nie udało się wczytać faktury-wzoru');
    // Arkusz „Edytuj” nie zmienia wzoru — nie odsyłamy tam.
    expect(html).not.toContain('w ustawieniach faktury cyklicznej');
    expect(html).toContain('usuń tę fakturę cykliczną i utwórz ją z innej faktury-wzoru');
    expect(html).toContain('href="/invoices/recurring"');
  });
});

describe('?wzor=<id> (Duplikuj)', () => {
  it('sam podkład, bez pozycji cyklicznej', async () => {
    const html = await render({ wzor: TPL });
    expect(m.getRecurring).not.toHaveBeenCalled();
    expect(m.formProps.at(-1)).toMatchObject({ initialValues: podklad.values, recurringInvoiceId: null, prefill: null });
    expect(html).toContain('Kopia faktury FV/7/09/2026');
  });

  it('nieznana faktura: pusty formularz z komunikatem', async () => {
    m.prefillFromInvoice.mockResolvedValue(null);
    const html = await render({ wzor: TPL });
    expect(m.formProps.at(-1)).not.toHaveProperty('initialValues');
    expect(html).toContain('Nie znaleziono faktury do skopiowania');
  });
});

it('bez parametrów — jak dotąd: baner ostatniej faktury, bez komunikatu', async () => {
  const html = await render({});
  expect(m.formProps.at(-1)).toMatchObject({ prefill: { contractorName: 'Ostatni' } });
  expect(m.formProps.at(-1)).not.toHaveProperty('initialValues');
  expect(html).not.toContain('role="alert"');
});
