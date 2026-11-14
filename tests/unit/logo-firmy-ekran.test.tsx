// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sekcja „Logo na fakturze” w Ustawieniach → Firma (krok 2.2, część 1;
 * decyzja D1: nowa sekcja z istniejących komponentów, bez przestawiania
 * ekranu). Podgląd, wgranie, zmiana i usunięcie z potwierdzeniem; zmienia
 * właściciel i administrator, jak dane firmy. Atrapy: wysyłka pliku
 * (`postLogoUpload`, HTTP) i akcja serwera usunięcia.
 */

const m = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: m.toastError, success: m.toastSuccess } }));
vi.mock('@/lib/uploads/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/uploads/client')>()),
  postLogoUpload: m.upload,
}));
vi.mock('@/app/actions/company-logo', () => ({ deleteCompanyLogoAction: m.remove }));
// Okno potwierdzenia bez portalu base-ui (jsdom), jak w wplaty-czesciowe-ekran.test.tsx.
vi.mock('@/components/ui/alert-dialog', async () => {
  const React = await import('react');
  const Ctx = React.createContext<{ open: boolean; setOpen: (v: boolean) => void }>({ open: false, setOpen: () => {} });
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: ({ open, onOpenChange, children }: { open?: boolean; onOpenChange?: (v: boolean) => void; children?: ReactNode }) => (
      <Ctx.Provider value={{ open: Boolean(open), setOpen: (v) => onOpenChange?.(v) }}>{children}</Ctx.Provider>
    ),
    AlertDialogContent: ({ children }: { children?: ReactNode }) => (React.useContext(Ctx).open ? <div role="alertdialog">{children}</div> : null),
    AlertDialogHeader: Pass,
    AlertDialogFooter: Pass,
    AlertDialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    AlertDialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    AlertDialogCancel: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => {
      const ctx = React.useContext(Ctx);
      return <button type="button" disabled={disabled} onClick={() => ctx.setOpen(false)}>{children}</button>;
    },
    AlertDialogAction: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => (
      <button type="button" disabled={disabled} onClick={onClick}>{children}</button>
    ),
  };
});

import { CompanyLogoForm } from '@/components/settings/company-logo-form';

const TENANT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PODGLAD = 'https://magazyn.test/tenants/x/logo/a.png?podpis=1';

describe('CompanyLogoForm: widok', () => {
  it('logo jest: podgląd, opis wydruku, „Zmień logo” i „Usuń logo”, pole tylko PNG i JPEG', () => {
    const html = renderToStaticMarkup(<CompanyLogoForm initial={{ status: 'ok', previewUrl: PODGLAD, format: 'png' }} canEdit tenantId={TENANT} />);
    expect(html).toContain('Logo na fakturze');
    expect(html).toContain(`src="${PODGLAD.replace(/&/g, '&amp;')}"`);
    expect(html).toContain('alt="Logo firmy"');
    expect(html).toContain('Zmień logo');
    expect(html).toContain('Usuń logo');
    expect(html).toContain('accept="image/png,image/jpeg"');
    expect(html).toMatch(/PNG albo JPEG, najwyżej 2 MB/);
    expect(html).toMatch(/faktur, proform i ofert/);
    expect(html).toMatch(/KSeF/);
  });

  it('bez logo: „Brak logo” i „Wgraj logo”, bez usuwania', () => {
    const html = renderToStaticMarkup(<CompanyLogoForm initial={{ status: 'none' }} canEdit tenantId={TENANT} />);
    expect(html).toContain('Brak logo');
    expect(html).toContain('Wgraj logo');
    expect(html).not.toContain('Usuń logo');
  });

  it('rola bez uprawnień: podgląd i komunikat, bez przycisków i pola pliku', () => {
    const html = renderToStaticMarkup(<CompanyLogoForm initial={{ status: 'ok', previewUrl: PODGLAD, format: 'png' }} canEdit={false} tenantId={TENANT} />);
    expect(html).toContain('alt="Logo firmy"');
    expect(html).toContain('Zmienić to może właściciel albo administrator firmy.');
    expect(html).not.toContain('Zmień logo');
    expect(html).not.toContain('type="file"');
  });

  it('brak pliku w magazynie: co się dzieje z wydrukiem i co zrobić', () => {
    const html = renderToStaticMarkup(<CompanyLogoForm initial={{ status: 'missing' }} canEdit tenantId={TENANT} />);
    expect(html).toMatch(/Nie ma pliku logo/);
    expect(html).toMatch(/bez logo/);
    expect(html).toContain('Wgraj logo');
    expect(html).toContain('Usuń logo');
  });

  it('odczyt się nie udał: komunikat z prośbą o odświeżenie, bez przycisków', () => {
    const html = renderToStaticMarkup(<CompanyLogoForm initial={{ status: 'unavailable' }} canEdit tenantId={TENANT} />);
    expect(html).toMatch(/Odśwież stronę/);
    expect(html).not.toContain('Wgraj logo');
  });
});

describe('CompanyLogoForm: zachowanie', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const pole = () => host.querySelector('input[type="file"]') as HTMLInputElement;
  const przycisk = (napis: string) =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === napis) as HTMLButtonElement | undefined;

  async function wybierz(plik: File) {
    Object.defineProperty(pole(), 'files', { configurable: true, value: [plik] });
    await act(async () => {
      pole().dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('wybrany plik idzie trasą z polami logo i tenantId; po zapisie nowy podgląd i toast', async () => {
    m.upload.mockResolvedValue({ success: true, logo: { previewUrl: PODGLAD, format: 'png', width: 1200, height: 266 } });
    act(() => root.render(<CompanyLogoForm initial={{ status: 'none' }} canEdit tenantId={TENANT} />));
    await wybierz(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' }));
    const form = m.upload.mock.calls[0]![0] as FormData;
    expect(form.get('tenantId')).toBe(TENANT);
    expect((form.get('logo') as File).name).toBe('logo.png');
    expect(host.querySelector('img')?.getAttribute('src')).toBe(PODGLAD);
    expect(m.toastSuccess).toHaveBeenCalledWith('Logo zapisane');
  });

  it('plik ponad 2 MB: komunikat od razu, bez wysyłki', async () => {
    act(() => root.render(<CompanyLogoForm initial={{ status: 'none' }} canEdit tenantId={TENANT} />));
    await wybierz(new File([new Uint8Array(2_000_001)], 'duze.png', { type: 'image/png' }));
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.toastError).toHaveBeenCalledWith(expect.stringMatching(/najwyżej 2 MB/));
  });

  it('odmowa serwera: komunikat z serwera w toaście, podgląd bez zmian', async () => {
    m.upload.mockResolvedValue({ success: false, error: 'Logo w SVG nie jest obsługiwane.' });
    act(() => root.render(<CompanyLogoForm initial={{ status: 'none' }} canEdit tenantId={TENANT} />));
    await wybierz(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    expect(m.toastError).toHaveBeenCalledWith('Logo w SVG nie jest obsługiwane.');
    expect(host.textContent).toContain('Brak logo');
  });

  it('„Usuń logo” pyta o potwierdzenie, potem usuwa i chowa podgląd', async () => {
    m.remove.mockResolvedValue({ success: true });
    act(() => root.render(<CompanyLogoForm initial={{ status: 'ok', previewUrl: PODGLAD, format: 'png' }} canEdit tenantId={TENANT} />));
    await act(async () => przycisk('Usuń logo')!.click());
    expect(m.remove).not.toHaveBeenCalled();
    const okno = host.querySelector('[role="alertdialog"]')!;
    expect(okno.textContent).toMatch(/Usunąć logo\?/);
    const potwierdz = Array.from(okno.querySelectorAll('button')).find((b) => b.textContent?.includes('Usuń logo')) as HTMLButtonElement;
    await act(async () => potwierdz.click());
    expect(m.remove).toHaveBeenCalledOnce();
    expect(m.toastSuccess).toHaveBeenCalledWith('Logo usunięte');
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('Brak logo');
  });
});
