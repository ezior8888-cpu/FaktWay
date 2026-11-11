// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FirmaKlienta, WynikMoichKlientow } from '@/lib/dashboard/moi-klienci';
import { formatPlMoney } from '@/lib/format/pl';

/**
 * Ekran „Moi klienci” (krok 6.2, część 2): lista firm z liczbą kosztów do
 * opisania, fakturami po terminie, najbliższym terminem (tylko przy module)
 * i statusem KSeF; pusta lista i błąd z komunikatem, co zrobić; „Otwórz”
 * przełącza firmę tą samą akcją co „Moje firmy” i prowadzi na pulpit.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  wynik: { ok: true, firmy: [] } as WynikMoichKlientow,
  opcje: null as unknown,
  switchOrg: vi.fn(),
  push: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: () => {}, replace: () => {}, prefetch: () => {} }),
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/app/actions/organizations', () => ({ setActiveOrganizationAction: mocks.switchOrg }));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({
    tenantId: 'firma-a',
    role: 'accountant',
    user: { id: 'u-1', email: 'ksiegowa@example.test' },
    supabase: { rpc: async () => ({ data: [], error: null }) },
  }),
}));
vi.mock('@/lib/dashboard/moi-klienci', async (orig) => ({
  ...(await orig<typeof import('@/lib/dashboard/moi-klienci')>()),
  czytajMoichKlientow: async (_client: unknown, opcje: unknown) => {
    mocks.opcje = opcje;
    return mocks.wynik;
  },
}));

const { default: MoiKlienciPage } = await import('@/app/(dashboard)/moi-klienci/page');
const { OtworzFirme } = await import('@/app/(dashboard)/moi-klienci/_components/otworz-firme');

function firma(z: Partial<FirmaKlienta> = {}): FirmaKlienta {
  return {
    organizationId: 'firma-a',
    nazwa: 'Alfa sp. z o.o.',
    nip: '1234567890',
    rola: 'accountant',
    aktywna: true,
    kosztyDoOpisania: 0,
    poTerminie: { stan: 'ok', liczba: 0, sumaGr: 0, walutaObca: 0 },
    ksef: 'polaczono',
    termin: null,
    ...z,
  };
}

async function strona(): Promise<string> {
  return renderToStaticMarkup(await MoiKlienciPage());
}

beforeEach(() => {
  mocks.wynik = { ok: true, firmy: [] };
  mocks.opcje = null;
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('lista firm', () => {
  it('przy każdej firmie: koszty do opisania, po terminie, termin tylko przy module, KSeF, „Otwórz”', async () => {
    mocks.wynik = {
      ok: true,
      firmy: [
        firma({
          kosztyDoOpisania: 3,
          poTerminie: { stan: 'ok', liczba: 2, sumaGr: 273000, walutaObca: 1 },
          termin: { stan: 'ok', data: '2026-11-20', rodzaje: ['zus', 'ryczalt', 'zaliczkaPit'] },
        }),
        firma({
          organizationId: 'firma-b',
          nazwa: 'Beta S.A.',
          nip: '9480000021',
          rola: 'owner',
          aktywna: false,
          ksef: 'certyfikat_wygasl',
        }),
      ],
    };
    const html = await strona();

    expect(html).toContain('<h1');
    expect(html).toContain('Moi klienci');
    expect(mocks.opcje).toMatchObject({ aktywnaFirma: 'firma-a' });
    expect(html).toContain('Alfa sp. z o.o.');
    expect(html).toContain('Beta S.A.');
    expect(html).toContain('1234567890');
    expect(html).toContain('księgowy');
    expect(html).toContain('właściciel');
    expect(html).toContain('Koszty do opisania');
    expect(html).toContain(`2 faktury, ${formatPlMoney(2730)} zł`);
    expect(html).toContain('Poza sumą: 1 faktura w walucie obcej');
    expect(html).toContain('20.11.2026, ZUS i podatek dochodowy');
    // Termin z kalendarza nie udaje, że wie o zapłacie (R2).
    expect(html).toContain('bez sprawdzania, czy już zapłacone');
    // Termin tylko raz: druga firma nie ma modułu, więc wiersza terminu nie ma wcale.
    expect(html.match(/Najbliższy termin/g)).toHaveLength(1);
    expect(html).toContain('Połączono');
    expect(html).toContain('Certyfikat wygasł');
    expect(html).toContain('w Ustawieniach, w zakładce KSeF');
    expect(html).toContain('aria-label="Otwórz firmę Alfa sp. z o.o."');
    expect(html).toContain('aria-label="Otwórz firmę Beta S.A."');
    expect(html).toContain('Otwarta');
    // Teksty bez długich myślników (strażnik tekstów, decyzja Bartosza).
    expect(html).not.toMatch(/[—–]/);
  });

  it('brak sumy przy fakturach bez znanego środowiska i komunikat przy nieznanym terminie', async () => {
    mocks.wynik = {
      ok: true,
      firmy: [firma({ poTerminie: { stan: 'srodowisko' }, termin: { stan: 'nieznany' } })],
    };
    const html = await strona();
    expect(html).toContain('wymagają uzgodnienia środowiska KSeF');
    expect(html).toContain('Nie udało się sprawdzić terminów. Odśwież stronę za chwilę.');
    expect(html).not.toContain(' zł');
  });

  it('pusta lista: komunikat, skąd biorą się firmy', async () => {
    const html = await strona();
    expect(html).toContain('Nie masz jeszcze firm klientów');
    expect(html).toContain('zaprosi');
    expect(html).not.toContain('Otwórz firmę');
  });

  it('błąd odczytu: komunikat z wyjściem zamiast pustej listy', async () => {
    mocks.wynik = { ok: false };
    const html = await strona();
    expect(html).toContain('Nie udało się wczytać firm. Odśwież stronę za chwilę.');
    expect(html).not.toContain('Nie masz jeszcze firm klientów');
  });
});

describe('„Otwórz” przełącza firmę', () => {
  async function kliknij(wynikAkcji: unknown) {
    mocks.switchOrg.mockResolvedValue(wynikAkcji);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<OtworzFirme organizationId="firma-b" nazwa="Beta S.A." />);
    });
    const przycisk = host.querySelector('button');
    expect(przycisk?.textContent).toBe('Otwórz');
    await act(async () => {
      przycisk!.click();
    });
    act(() => root.unmount());
  }

  it('ta sama akcja co „Moje firmy”, potem pulpit tej firmy', async () => {
    await kliknij({ success: true });
    expect(mocks.switchOrg).toHaveBeenCalledWith('firma-b');
    expect(mocks.push).toHaveBeenCalledWith('/dashboard');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('odmowa akcji: komunikat, bez przejścia', async () => {
    await kliknij({ success: false, error: 'Brak dostępu do tej organizacji' });
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('Brak dostępu do tej organizacji');
  });
});
