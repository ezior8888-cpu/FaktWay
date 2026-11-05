// @vitest-environment jsdom
import { act, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Kreator ustawień podatkowych i jego strona (plan księgowości JDG, K2).
 * Strona: 404 poza pilotażem, dane z profilu, status VAT tylko pokazany.
 * Kreator: walidacja tym samym schematem co akcja, stawka tylko przy
 * ryczałcie, bez podpowiadania, tryb tylko do odczytu dla członka firmy.
 */

const mocks = vi.hoisted(() => ({
  akcja: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  wlaczony: true,
  wersje: [] as unknown[],
  rola: 'owner',
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock('@/app/actions/ksiegowosc-profil', () => ({ zapiszProfilPodatkowyAction: mocks.akcja }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({ supabase: {}, tenantId: 'firma-1', role: mocks.rola }),
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: async () => ({ wlaczony: mocks.wlaczony }) }));
vi.mock('@/lib/format/warsaw-date', () => ({ todayInWarsaw: () => '2027-03-10' }));
vi.mock('@/lib/invoices/vat-exemption', () => ({ readTenantVatExemption: async () => null }));
vi.mock('@/lib/invoices/business-start', () => ({ readTenantBusinessStart: async () => null }));
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: async () => mocks.wersje,
}));

const { default: UstawieniaPodatkowePage } = await import('@/app/(dashboard)/reports/ustawienia-podatkowe/page');
const { UstawieniaPodatkoweForm } = await import('@/components/ksiegowosc/ustawienia-podatkowe-form');

const WERSJA = {
  id: 'p1',
  validFrom: '2027-01-01',
  forma: 'ryczalt' as const,
  stawkaDomyslna: 1200,
  zusEtap: 'pelny' as const,
  zusOd: null,
  chorobowe: true,
  nrsZus: null,
};

function elementy(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((dziecko) => elementy(dziecko, out));
  else if (isValidElement(node)) {
    out.push(node);
    elementy((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

let root: Root | null = null;
let kontener: HTMLDivElement;

function pokaz(props: Partial<Parameters<typeof UstawieniaPodatkoweForm>[0]> = {}) {
  kontener = document.createElement('div');
  document.body.append(kontener);
  root = createRoot(kontener);
  act(() => {
    root!.render(
      <UstawieniaPodatkoweForm poczatkowa={null} domyslnyOd="2027-01-01" canEdit statusVat="Czynny podatnik VAT" {...props} />,
    );
  });
}

function kliknij(element: Element | null | undefined) {
  if (!element) throw new Error('brak elementu');
  act(() => {
    (element as HTMLElement).click();
  });
}

const przycisk = (tekst: string) => [...kontener.querySelectorAll('button')].find((b) => b.textContent?.trim() === tekst);
const radio = (etykieta: string) =>
  [...kontener.querySelectorAll('label')].find((l) => l.textContent?.includes(etykieta))?.querySelector('[role="radio"]');

beforeEach(() => {
  mocks.akcja.mockReset().mockResolvedValue({ success: true, wersja: WERSJA });
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.wlaczony = true;
  mocks.wersje = [];
  mocks.rola = 'owner';
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('strona ustawień podatkowych', () => {
  it('firma poza pilotażem dostaje 404', async () => {
    mocks.wlaczony = false;
    await expect(UstawieniaPodatkowePage()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('bez profilu: kreator z domyślnym 1 stycznia, bez historii', async () => {
    const drzewo = await UstawieniaPodatkowePage();
    const kreator = elementy(drzewo).find((el) => el.type === UstawieniaPodatkoweForm)!;
    expect(kreator.props).toMatchObject({ poczatkowa: null, domyslnyOd: '2027-01-01', canEdit: true, statusVat: 'Czynny podatnik VAT' });
    expect(renderToStaticMarkup(drzewo)).not.toContain('Historia ustawień');
  });

  it('z profilem: bieżąca wersja w kreatorze i historia; członek firmy bez edycji', async () => {
    mocks.wersje = [WERSJA];
    mocks.rola = 'member';
    const drzewo = await UstawieniaPodatkowePage();
    const kreator = elementy(drzewo).find((el) => el.type === UstawieniaPodatkoweForm)!;
    expect(kreator.props).toMatchObject({ poczatkowa: WERSJA, domyslnyOd: '2027-01-01', canEdit: false });
    const html = renderToStaticMarkup(drzewo);
    expect(html).toContain('Historia ustawień');
    expect(html).toContain('od 01.01.2027');
    expect(html).toContain('Pełne składki, z chorobowym');
  });
});

describe('kreator', () => {
  it('bez wybranej formy nie wysyła i mówi, czego brakuje', async () => {
    pokaz();
    kliknij(przycisk('Zapisz'));
    expect(mocks.akcja).not.toHaveBeenCalled();
    expect(kontener.textContent).toContain('Brak formy opodatkowania.');
  });

  it('komunikat przy polu znika, gdy klient je poprawi; inne zostają', () => {
    pokaz();
    kliknij(przycisk('Zapisz'));
    expect(kontener.textContent).toContain('Brak formy opodatkowania.');
    kliknij(radio('Skala podatkowa'));
    expect(kontener.textContent).not.toContain('Brak formy opodatkowania.');
    expect(kontener.textContent).toContain('Brak rodzaju składek ZUS.');
  });

  it('stawki ryczałtu dopiero przy ryczałcie, z odnośnikiem do podatki.gov.pl i bez dobierania', () => {
    pokaz();
    expect(kontener.textContent).not.toContain('Stawka ryczałtu');
    kliknij(radio('Ryczałt od przychodów ewidencjonowanych'));
    expect(kontener.textContent).toContain('Stawka ryczałtu');
    expect(kontener.textContent).toContain('FaktWay jej nie dobiera');
    expect(kontener.querySelectorAll('[aria-labelledby="profil-stawka"] [role="radio"]')).toHaveLength(8);
    expect(kontener.querySelector('a[href="https://podatki.gov.pl/podatki-firmowe/pit/stawki-i-limity/"]')).not.toBeNull();
  });

  it('pełny profil idzie do akcji tym samym kształtem co schemat', async () => {
    pokaz({ poczatkowa: WERSJA });
    await act(async () => {
      przycisk('Zapisz')!.click();
    });
    expect(mocks.akcja).toHaveBeenCalledWith({
      validFrom: '2027-01-01',
      forma: 'ryczalt',
      stawkaDomyslna: 1200,
      zusEtap: 'pelny',
      zusOd: null,
      chorobowe: true,
      nrsZus: null,
    });
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it('odmowa akcji pokazuje komunikat przy polu', async () => {
    mocks.akcja.mockResolvedValueOnce({ success: false, error: 'Forma opodatkowania zmienia się tylko od 1 stycznia.', pole: 'validFrom' });
    pokaz({ poczatkowa: WERSJA });
    await act(async () => {
      przycisk('Zapisz')!.click();
    });
    expect(mocks.toastError).toHaveBeenCalledWith('Forma opodatkowania zmienia się tylko od 1 stycznia.');
    expect(kontener.querySelector('#blad-validFrom')?.textContent).toContain('1 stycznia');
  });

  it('chorobowe tylko przy składkach społecznych', () => {
    pokaz({ poczatkowa: { ...WERSJA, zusEtap: 'etat_obok' } });
    expect(kontener.textContent).not.toContain('Dobrowolne ubezpieczenie chorobowe');
    kliknij(radio('Pełne składki'));
    expect(kontener.textContent).toContain('Dobrowolne ubezpieczenie chorobowe');
  });

  it('członek firmy widzi ustawienia bez przycisku zapisu', () => {
    pokaz({ poczatkowa: WERSJA, canEdit: false });
    expect(przycisk('Zapisz')).toBeUndefined();
    expect(kontener.textContent).toContain('właściciel albo administrator');
  });

  it('teksty bez długich myślników', () => {
    const html = renderToStaticMarkup(
      <UstawieniaPodatkoweForm poczatkowa={WERSJA} domyslnyOd="2027-01-01" canEdit statusVat="Czynny podatnik VAT" />,
    );
    expect(html).not.toMatch(/[—–]/);
  });
});
