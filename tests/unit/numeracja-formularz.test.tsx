// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ preview: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: vi.fn(),
  saveAndSendInvoiceAction: vi.fn(),
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));
vi.mock('@/components/invoices/advance-actions', () => ({
  saveAdvanceAction: vi.fn(),
  saveAndSendAdvanceAction: vi.fn(),
}));
vi.mock('@/app/actions/numeracja', () => ({ invoiceNumberPreviewAction: mocks.preview }));

import { AdvanceInvoiceForm } from '@/components/invoices/advance-form';
import { InvoiceForm } from '@/components/invoices/invoice-form';
import {
  nextNumberFields,
  useSeriesNumber,
  type NumberFieldWrite,
} from '@/components/invoices/numeracja/series-select-row';
import type { InvoiceNumbering } from '@/lib/numeracja/model';

/**
 * Krok 2.5 w formularzach: podpowiedź numeru z serii domyślnej rodzaju,
 * wybór serii tylko przy co najmniej dwóch seriach (D1: firma z jedną serią
 * widzi formularz bez zmian), a zmiana serii albo daty podmienia numer tylko
 * wtedy, gdy klient nie wpisał własnego.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BASIC = '0c0b5a9e-1d2f-4e3a-8b4c-5d6e7f809102';
const FX = '5f4e3d2c-1b0a-4987-8654-3210fedcba98';

const twoSeries: InvoiceNumbering = {
  kind: 'regular',
  selectedId: BASIC,
  options: [
    { id: BASIC, name: 'Podstawowa', pattern: null, preview: 'FV/2026/11/008' },
    { id: FX, name: 'Waluty', pattern: 'WAL/{RRRR}/{NNN}', preview: 'WAL/2026/005' },
  ],
};
const legacyOnly: InvoiceNumbering = {
  kind: 'regular',
  selectedId: null,
  options: [{ id: null, name: 'Numeracja jak dotąd', pattern: null, preview: 'FV/2026/11/008' }],
};
const seller = {
  nip: '1234567890', name: 'Firma testowa',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.preview.mockReset();
  // Układ pozycji formularza pyta o szerokość ekranu (jsdom nie ma matchMedia).
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe('pole numeru po zmianie serii', () => {
  it('numer z podpowiedzi (nietknięty) albo pusty: nowa podpowiedź', () => {
    expect(nextNumberFields({ number: 'FV/2026/11/008', preview: 'FV/2026/11/008' }, FX, 'WAL/2026/005'))
      .toEqual({ seriesId: FX, preview: 'WAL/2026/005', number: 'WAL/2026/005' });
    expect(nextNumberFields({ number: '  ', preview: undefined }, FX, 'WAL/2026/005'))
      .toEqual({ seriesId: FX, preview: 'WAL/2026/005', number: 'WAL/2026/005' });
  });

  it('numer wpisany ręcznie zostaje, zmienia się tylko seria i podpowiedź', () => {
    expect(nextNumberFields({ number: 'MOJ/1', preview: 'FV/2026/11/008' }, FX, 'WAL/2026/005'))
      .toEqual({ seriesId: FX, preview: 'WAL/2026/005', number: undefined });
  });

  it('seria bez podpowiedzi: puste pole zamiast starego numeru innej serii', () => {
    expect(nextNumberFields({ number: 'FV/2026/11/008', preview: 'FV/2026/11/008' }, FX, null))
      .toEqual({ seriesId: FX, preview: undefined, number: '' });
  });
});

/** Formularz w przeglądarce (jsdom): RHF wpisuje wartości domyślne w pola dopiero po zamontowaniu. */
function mountForm(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(element));
  return {
    number: () => (host!.querySelector('#internalNumber') as HTMLInputElement).value,
    html: () => host!.innerHTML,
  };
}

describe('formularze z numeracją', () => {
  it('zwykła faktura, dwie serie: wybór serii i numer z serii domyślnej', () => {
    const view = mountForm(<InvoiceForm tenantId={TENANT} numbering={twoSeries} suggestedNumber="FV/2026/11/008" />);
    expect(view.html()).toContain('Seria numeracji');
    expect(view.number()).toBe('FV/2026/11/008');
  });

  it('zwykła faktura, firma bez serii: formularz jak dotąd (bez wyboru serii), numer z podpowiedzi', () => {
    const html = renderToStaticMarkup(<InvoiceForm tenantId={TENANT} numbering={legacyOnly} suggestedNumber="FV/2026/11/008" />);
    expect(html).not.toContain('Seria numeracji');
    const view = mountForm(<InvoiceForm tenantId={TENANT} numbering={legacyOnly} suggestedNumber="FV/2026/11/008" />);
    expect(view.number()).toBe('FV/2026/11/008');
  });

  it('zaliczka: numer z podpowiedzi serii zaliczek', () => {
    const advance: InvoiceNumbering = { ...legacyOnly, kind: 'advance', options: [{ ...legacyOnly.options[0]!, preview: 'ZAL/2026/11/003' }] };
    const view = mountForm(<AdvanceInvoiceForm initialSeller={seller} tenantId={TENANT} numbering={advance} />);
    expect(view.number()).toBe('ZAL/2026/11/003');
    expect(view.html()).not.toContain('Seria numeracji');
  });

  it('zaliczka bez numeracji: pole numeru puste jak dotąd', () => {
    const view = mountForm(<AdvanceInvoiceForm initialSeller={seller} tenantId={TENANT} />);
    expect(view.number()).toBe('');
  });
});

/** Mały formularz: pole numeru i data jak w prawdziwych formularzach, hook serii. */
function Harness({ onWrite }: { onWrite: (w: NumberFieldWrite) => void }) {
  const [state, setState] = useState({ number: 'FV/2026/11/008', preview: 'FV/2026/11/008' as string | undefined, issueDate: '2026-11-11' });
  const series = useSeriesNumber({
    numbering: twoSeries,
    issueDate: state.issueDate,
    read: () => ({ number: state.number, preview: state.preview }),
    write: (w) => {
      onWrite(w);
      setState((s) => ({ ...s, preview: w.preview, number: w.number ?? s.number }));
    },
  });
  return (
    <div>
      <output data-testid="numer">{state.number}</output>
      <output data-testid="seria">{series.seriesId}</output>
      <button type="button" onClick={() => series.selectSeries(FX)}>waluty</button>
      <button type="button" onClick={() => setState((s) => ({ ...s, number: 'MOJ/1' }))}>wpisz</button>
      <button type="button" onClick={() => setState((s) => ({ ...s, issueDate: '2026-10-31' }))}>data</button>
    </div>
  );
}

function mount(onWrite = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness onWrite={onWrite} />));
  const click = (label: string) =>
    act(() => [...host!.querySelectorAll('button')].find((b) => b.textContent === label)!.click());
  const text = (id: string) => host!.querySelector(`[data-testid="${id}"]`)!.textContent;
  return { click, text, onWrite };
}

describe('wybór serii i zmiana daty w formularzu', () => {
  it('przy otwarciu bez zapytania o podpowiedź (przyszła z serwera)', async () => {
    vi.useFakeTimers();
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('zmiana serii: od razu podpowiedź tej serii w nietkniętym polu, potem odświeżenie dla daty wystawienia', async () => {
    vi.useFakeTimers();
    mocks.preview.mockResolvedValue({ preview: 'WAL/2026/006' });
    const { click, text } = mount();

    click('waluty');
    expect(text('numer')).toBe('WAL/2026/005');
    expect(text('seria')).toBe(FX);

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(mocks.preview).toHaveBeenCalledWith('regular', FX, '2026-11-11');
    expect(text('numer')).toBe('WAL/2026/006');
  });

  it('numer wpisany ręcznie zostaje po zmianie serii i daty', async () => {
    vi.useFakeTimers();
    mocks.preview.mockResolvedValue({ preview: 'FV/2026/10/015' });
    const { click, text } = mount();

    click('wpisz');
    click('waluty');
    click('data');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

    expect(text('numer')).toBe('MOJ/1');
    expect(mocks.preview).toHaveBeenCalledWith('regular', FX, '2026-10-31');
  });
});
