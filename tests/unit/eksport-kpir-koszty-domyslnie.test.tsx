// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  startExportAction: vi.fn(),
  downloadExportFileAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/app/actions/exports', () => actions);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NewExportForm, type NewExportFormProps } from '@/components/exports/exports-center';
import { includeReceivedAfterFormatChange } from '@/lib/exports/form-defaults';

/**
 * F-058 (audyt bloku 1): KPiR Excel bierze koszty (faktury otrzymane
 * i paragony z `expenses`) tylko przy `includeReceived`, a to pole było
 * domyślnie odznaczone — klient dostawał księgę z samymi przychodami.
 *
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): KPiR jest
 * domyślnym formatem i nie ma już pól zakresu (zawsze sprzedaż, koszty
 * i korekty) — więc test sprawdza to, co naprawdę leci do akcji serwera:
 * `includeReceived: true` przy KPiR, także po powrocie z CSV.
 *
 * Tamże nowa blokada z góry: JPK_FA bez urzędu skarbowego firmy i tak by
 * odmówił, więc przycisk jest wyłączony z powodem i wyjściem „Ustaw” —
 * ale tylko przy `taxOfficeSet === false`. Gdy odczyt urzędu się nie udał
 * (`undefined`), nic nie blokujemy.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  actions.startExportAction.mockReset();
  actions.startExportAction.mockResolvedValue({ success: true, jobId: 'job-1' });
  router.refresh.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(props: NewExportFormProps = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<NewExportForm currentMonth="2026-10" {...props} />));
  return host;
}

const generate = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Wygeneruj plik')) as HTMLButtonElement;

/** Kafelek formatu to etykieta ukrytego radia — klik jak użytkownik. */
async function chooseFormat(el: HTMLElement, name: string) {
  const tile = [...el.querySelectorAll('label')].find((l) => l.textContent?.startsWith(name));
  expect(tile, `brak kafelka „${name}”`).toBeDefined();
  await act(async () => tile!.click());
}

/** Pole wyboru (Base UI: span role=checkbox) po nazwie z etykiety (`aria-labelledby`). */
function checkboxNamed(el: HTMLElement, name: string): HTMLElement | undefined {
  return [...el.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((box) => {
    const labelId = box.getAttribute('aria-labelledby');
    return labelId ? document.getElementById(labelId)?.textContent?.includes(name) : false;
  });
}

const checkedFormat = (el: HTMLElement) =>
  el.querySelector('[role="radiogroup"][aria-label="Format pliku"] [role="radio"][aria-checked="true"]')
    ?.parentElement?.querySelector('label')?.textContent;

describe('includeReceivedAfterFormatChange', () => {
  it('KPiR zawsze z kosztami', () => {
    expect(includeReceivedAfterFormatChange('kpir_excel', false)).toBe(true);
  });

  it('inne formaty zostawiają wybór użytkownika', () => {
    expect(includeReceivedAfterFormatChange('jpk_fa', false)).toBe(false);
    expect(includeReceivedAfterFormatChange('csv_universal', true)).toBe(true);
  });
});

describe('Nowy plik — KPiR z kosztami (F-058)', () => {
  it('domyślnie KPiR Excel, a zakres mówi, że koszty to także paragony', async () => {
    const el = await render();
    expect(checkedFormat(el)).toContain('KPiR Excel');
    expect(el.textContent).toContain('paragony');
    // Przy KPiR nie ma pól wyboru — nic nie da się odznaczyć.
    expect(el.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
  });

  it('„Wygeneruj plik” wysyła KPiR z includeReceived: true za poprzedni miesiąc', async () => {
    const el = await render();
    await act(async () => generate(el).click());
    expect(actions.startExportAction).toHaveBeenCalledTimes(1);
    expect(actions.startExportAction).toHaveBeenCalledWith({
      format: 'kpir_excel',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      includeIssued: true,
      includeReceived: true,
      includeCorrections: true,
    });
    // Sukces: od razu odświeżamy historię (bez dawnego 3-sekundowego opóźnienia).
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('CSV pokazuje pole „Faktury otrzymane”; powrót do KPiR znowu wysyła koszty', async () => {
    const el = await render();
    await chooseFormat(el, 'CSV uniwersalny');
    const received = checkboxNamed(el, 'Faktury otrzymane');
    expect(received).toBeDefined();
    expect(received!.getAttribute('aria-checked')).toBe('false');

    await act(async () => generate(el).click());
    expect(actions.startExportAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: 'csv_universal', includeReceived: false }),
    );

    await chooseFormat(el, 'KPiR Excel');
    expect(checkboxNamed(el, 'Faktury otrzymane')).toBeUndefined();
    await act(async () => generate(el).click());
    expect(actions.startExportAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: 'kpir_excel', includeIssued: true, includeReceived: true, includeCorrections: true }),
    );
  });

  it('CSV bez wystawionych i otrzymanych: przycisk wyłączony z widocznym powodem', async () => {
    const el = await render();
    await chooseFormat(el, 'CSV uniwersalny');
    const issued = checkboxNamed(el, 'Faktury wystawione');
    expect(issued?.getAttribute('aria-checked')).toBe('true');
    await act(async () => issued!.click());
    expect(generate(el).disabled).toBe(true);
    expect(el.textContent).toContain('Zaznacz faktury wystawione albo otrzymane.');
    expect(generate(el).getAttribute('aria-describedby')).toBe('export-reason');
  });
});

describe('Nowy plik — JPK_FA bez urzędu skarbowego (blokada z góry)', () => {
  /** Kafelek „Brak urzędu skarbowego” (blok z przyciskiem „Ustaw”). */
  const taxOfficeTile = (el: HTMLElement) =>
    [...el.querySelectorAll('p')].find((p) => p.textContent === 'Brak urzędu skarbowego')?.parentElement ?? null;

  it('brak urzędu: przycisk wyłączony z powodem, wyjście „Ustaw” do ustawień księgowej', async () => {
    const el = await render({ taxOfficeSet: false });
    await chooseFormat(el, 'JPK_FA');
    expect(generate(el).disabled).toBe(true);
    expect(el.textContent).toContain('Najpierw ustaw urząd skarbowy.');
    expect(generate(el).getAttribute('aria-describedby')).toBe('export-reason');
    expect(document.getElementById('export-reason')?.textContent).toBe('Najpierw ustaw urząd skarbowy.');
    const tile = taxOfficeTile(el);
    expect(tile, 'brak kafelka „Brak urzędu skarbowego”').not.toBeNull();
    const fix = tile!.querySelector('a');
    expect(fix?.textContent).toBe('Ustaw');
    expect(fix?.getAttribute('href')).toBe('/settings/accountant');
    await act(async () => generate(el).click());
    expect(actions.startExportAction).not.toHaveBeenCalled();
  });

  it('nie wiadomo, czy urząd jest (odczyt się nie udał): nic nie blokujemy', async () => {
    const el = await render();
    await chooseFormat(el, 'JPK_FA');
    expect(taxOfficeTile(el)).toBeNull();
    expect(generate(el).disabled).toBe(false);
    expect(generate(el).hasAttribute('aria-describedby')).toBe(false);
    await act(async () => generate(el).click());
    expect(actions.startExportAction).toHaveBeenCalledWith(
      // JPK_FA zawsze bez zakupów — generator ich nie czyta.
      expect.objectContaining({ format: 'jpk_fa', includeIssued: true, includeReceived: false, includeCorrections: true }),
    );
  });

  it('brak urzędu nie blokuje KPiR — urząd jest potrzebny tylko w JPK', async () => {
    const el = await render({ taxOfficeSet: false });
    expect(checkedFormat(el)).toContain('KPiR Excel');
    expect(taxOfficeTile(el)).toBeNull();
    expect(generate(el).disabled).toBe(false);
    await act(async () => generate(el).click());
    expect(actions.startExportAction).toHaveBeenCalledWith(expect.objectContaining({ format: 'kpir_excel' }));
  });
});
