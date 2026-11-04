// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E3 / P4 (PLAN-FINORA §9 „Każdy PR etapu”, pkt 5): na ekranie przeniesionym
 * w etapie nie zostaje „szkło”. Podgląd faktury składa się też z kart UPO,
 * błędu KSeF i przycisku e-maila — do E3 miały `backdrop-blur-glass`,
 * `rounded-3xl` i warianty przycisku `glass` / `glass-primary`.
 */

vi.mock('@/app/(dashboard)/invoices/[id]/upo-actions', () => ({
  getUpoPdfAction: vi.fn(),
  getUpoXmlAction: vi.fn(),
}));
vi.mock('@/components/invoices/actions-detail', () => ({ emailInvoiceAction: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { InvoiceErrorDisplay } from '@/components/invoices/error-display';
import { EmailInvoiceButton } from '@/components/invoices/email-invoice-button';
import { UpoDownload } from '@/components/invoices/upo-download';

const SZKLO = /glass|backdrop-blur|rounded-3xl|rounded-2xl|white\/55|rgba\(15,10,30/;

describe('podgląd faktury — karty bez szkła', () => {
  it('karta błędu KSeF: treść, kod i podpowiedź, bez klas szkła', () => {
    const html = renderToStaticMarkup(
      <InvoiceErrorDisplay
        errorMessage="Nieprawidłowy NIP nabywcy"
        errorCode="450"
        errorField="buyer.nip"
        errorSuggestion="Popraw NIP w danych kontrahenta."
        invoiceId="i-1"
      />,
    );
    expect(html).toContain('Błąd wysyłki do KSeF');
    expect(html).toContain('Nieprawidłowy NIP nabywcy');
    expect(html).toContain('Kod techniczny: 450');
    expect(html).toContain('Jak naprawić');
    expect(html).toContain('href="/invoices/i-1?focus=buyer.nip"');
    expect(html).not.toMatch(SZKLO);
  });

  it('UPO gotowe: dwa przyciski pobierania w wariantach Finory', () => {
    const html = renderToStaticMarkup(
      <UpoDownload invoiceId="i-1" upoStatus="downloaded" ksefNumber="1234567890-20261017-ABC" />,
    );
    expect(html).toContain('UPO dostępne');
    expect(html).toContain('Pobierz UPO (PDF)');
    expect(html).toContain('Pobierz XML');
    expect(html).toContain('data-variant="default"');
    expect(html).toContain('data-variant="outline"');
    expect(html).not.toMatch(SZKLO);
  });

  it('UPO w drodze: komunikat bez klas szkła', () => {
    const html = renderToStaticMarkup(
      <UpoDownload invoiceId="i-1" upoStatus="pending" ksefNumber="1234567890-20261017-ABC" />,
    );
    expect(html).toContain('UPO w trakcie generowania');
    expect(html).not.toMatch(SZKLO);
  });
});

describe('przycisk e-maila — bez wariantu glass', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('zamknięty i rozwinięty: przyciski outline / default, żadnego glass', () => {
    act(() => root.render(<EmailInvoiceButton invoiceId="i-1" />));
    expect(host.textContent).toContain('Wyślij e-mailem');
    expect(host.innerHTML).not.toMatch(SZKLO);

    const open = host.querySelector('button');
    act(() => open!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    // E3b: formularz jest w arkuszu Finory (`send-invoice-sheet.tsx`), czyli w portalu poza `host`.
    const sheet = document.body.querySelector('[data-slot="sheet-content"]');
    expect(sheet, 'arkusz „Wyślij e-mailem” się nie otworzył').not.toBeNull();
    expect(sheet!.querySelector('input[type="email"]')).not.toBeNull();
    expect(sheet!.textContent).toContain('Anuluj');
    expect(sheet!.innerHTML).not.toMatch(SZKLO);
    expect(host.innerHTML).not.toMatch(SZKLO);
  });
});
