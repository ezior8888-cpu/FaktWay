// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

/**
 * Poprawka Bartosza 25.10.2026: plus dolnego paska prowadzi do wyboru
 * dokumentu (`/invoices/new`), a tam pierwszym kaflem jest „Wydatek” — na
 * telefonie ludzie głównie dodają koszty. Kafel otwiera aparat tylny albo
 * galerię i wgrywa plik tym samym hakiem co „+ Dodaj wydatek”.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ upload: vi.fn(), status: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/expenses', () => ({
  getOcrJobStatusAction: mocks.status,
  uploadExpensePhotoAction: mocks.upload,
}));

const { InvoiceTypeSelector } = await import('@/components/invoices/invoice-type-selector');

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<InvoiceTypeSelector />));
  return {
    host,
    unmount() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('Nowa faktura — kafel „Wydatek”', () => {
  it('jest pierwszym kaflem, przed rodzajami faktur', () => {
    const m = mount();
    const titles = [...m.host.querySelectorAll('h2')].map((h) => h.textContent);
    expect(titles[0]).toBe('Wydatek');
    expect(titles.slice(1)).toEqual(['Faktura zwykła', 'Faktura korygująca', 'Faktura zaliczkowa', 'Faktura rozliczająca']);
    m.unmount();
  });

  it('„Zrób zdjęcie” otwiera aparat tylny, „Wybierz plik” — galerię i PDF', () => {
    const m = mount();
    const inputs = [...m.host.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    const camera = inputs.find((i) => i.getAttribute('capture') === 'environment')!;
    const gallery = inputs.find((i) => i.accept.includes('application/pdf'))!;
    const cameraClick = vi.spyOn(camera, 'click');
    const galleryClick = vi.spyOn(gallery, 'click');
    const button = (label: string) => [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!;

    act(() => button('Zrób zdjęcie').click());
    expect(cameraClick).toHaveBeenCalledOnce();
    act(() => button('Wybierz plik').click());
    expect(galleryClick).toHaveBeenCalledOnce();
    m.unmount();
  });

  it('wybrany plik idzie do odczytu, a przyciski czekają z „Wgrywanie…”', async () => {
    mocks.upload.mockReturnValue(new Promise(() => {}));
    const m = mount();
    const camera = m.host.querySelector<HTMLInputElement>('input[capture="environment"]')!;
    Object.defineProperty(camera, 'files', { value: [new File(['x'], 'paragon.jpg', { type: 'image/jpeg' })], configurable: true });
    await act(async () => {
      camera.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mocks.upload).toHaveBeenCalledOnce();
    const buttons = [...m.host.querySelectorAll('button')];
    expect(buttons.some((b) => b.textContent?.includes('Wgrywanie'))).toBe(true);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    m.unmount();
  });
});
