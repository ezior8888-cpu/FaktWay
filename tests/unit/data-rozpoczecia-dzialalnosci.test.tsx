// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireOrgRole: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
  updates: [] as unknown[],
  before: null as string | null,
  updateError: null as { code?: string; message: string } | null,
  beforeError: null as { code?: string; message: string } | null,
  actionSpy: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/format/warsaw-date', () => ({ todayInWarsaw: () => '2026-10-19' }));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: mocks.requireOrgRole,
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      let patch: unknown = null;
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        update: (p: unknown) => {
          patch = p;
          return q;
        },
        eq: () => q,
        maybeSingle: async () => ({
          data: mocks.beforeError ? null : { business_started_on: mocks.before },
          error: mocks.beforeError,
        }),
        then: (ok: (v: unknown) => unknown) => {
          if (patch) mocks.updates.push(patch);
          return Promise.resolve({ error: mocks.updateError }).then(ok);
        },
      });
      return q;
    },
  }),
}));

vi.mock('@/app/actions/business-start', async (orig) => {
  const actual = await orig<typeof import('@/app/actions/business-start')>();
  return {
    ...actual,
    updateBusinessStartAction: (...args: Parameters<typeof actual.updateBusinessStartAction>) => {
      mocks.actionSpy(...args);
      return actual.updateBusinessStartAction(...args);
    },
  };
});

import { updateBusinessStartAction } from '@/app/actions/business-start';
import { BusinessStartForm } from '@/components/settings/business-start-form';
import { businessStartSchema, isMissingColumnError, readTenantBusinessStart } from '@/lib/invoices/business-start';
import { ActionAuthError } from '@/lib/supabase/auth-context';

const TODAY = '2026-10-19';
const CTX = { tenantId: 'ten-1', user: { id: 'u-1' }, role: 'owner' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updates = [];
  mocks.before = null;
  mocks.updateError = null;
  mocks.beforeError = null;
  mocks.requireOrgRole.mockResolvedValue(CTX);
});

describe('schemat daty rozpoczęcia działalności', () => {
  const parse = (v: string) => businessStartSchema(TODAY).safeParse(v);

  it('pusty tekst → null', () => {
    expect(parse('')).toMatchObject({ success: true, data: null });
    expect(parse('   ')).toMatchObject({ success: true, data: null });
  });
  it('odrzuca nieistniejący dzień, rok przed 1900 i przyszłość', () => {
    expect(parse('2026-02-30').success).toBe(false);
    expect(parse('1899-12-31').success).toBe(false);
    expect(parse('2026-10-20').success).toBe(false);
  });
  it('przyjmuje dziś i 1900-01-01, przycina spacje', () => {
    expect(parse(TODAY)).toMatchObject({ success: true, data: TODAY });
    expect(parse('1900-01-01')).toMatchObject({ success: true, data: '1900-01-01' });
    expect(parse(' 2020-05-01 ')).toMatchObject({ success: true, data: '2020-05-01' });
  });
});

describe('isMissingColumnError', () => {
  it('42703 i PGRST204 tak, reszta nie', () => {
    expect(isMissingColumnError('42703')).toBe(true);
    expect(isMissingColumnError('PGRST204')).toBe(true);
    expect(isMissingColumnError('23514')).toBe(false);
    expect(isMissingColumnError(undefined)).toBe(false);
  });
});

describe('readTenantBusinessStart', () => {
  const client = (res: { data?: unknown; error?: { code?: string; message: string } | null }) => {
    const q: Record<string, unknown> = {};
    Object.assign(q, {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: res.data ?? null, error: res.error ?? null }),
    });
    return { from: () => q } as never;
  };

  it('brak kolumny (42703) → null', async () => {
    await expect(readTenantBusinessStart(client({ error: { code: '42703', message: 'x' } }), 't')).resolves.toBeNull();
  });
  it('inny błąd → polski wyjątek', async () => {
    await expect(readTenantBusinessStart(client({ error: { code: '500', message: 'boom' } }), 't')).rejects.toThrow(
      /Nie można odczytać daty rozpoczęcia działalności/,
    );
  });
  it('brak kolumny w PostgREST (PGRST204) → null', async () => {
    await expect(readTenantBusinessStart(client({ error: { code: 'PGRST204', message: 'x' } }), 't')).resolves.toBeNull();
  });
  it('zwraca wartość', async () => {
    await expect(readTenantBusinessStart(client({ data: { business_started_on: '2024-03-01' } }), 't')).resolves.toBe(
      '2024-03-01',
    );
  });
});

describe('updateBusinessStartAction', () => {
  it('rola odmówiona → błąd i brak zapisu', async () => {
    mocks.requireOrgRole.mockRejectedValue(new ActionAuthError('Brak uprawnień'));
    await expect(updateBusinessStartAction('2020-05-01')).resolves.toEqual({ success: false, error: 'Brak uprawnień' });
    expect(mocks.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin']);
    expect(mocks.updates).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('zła data → błąd i brak zapisu', async () => {
    const r = await updateBusinessStartAction('2026-10-20');
    expect(r.success).toBe(false);
    expect(mocks.updates).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('42703 → komunikat o aktualizacji bazy', async () => {
    mocks.updateError = { code: '42703', message: 'x' };
    await expect(updateBusinessStartAction('2020-05-01')).resolves.toEqual({
      success: false,
      error: 'Ta funkcja czeka jeszcze na aktualizację bazy danych. Spróbuj ponownie później.',
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('PGRST204 (PostgREST: brak kolumny) → komunikat o aktualizacji bazy', async () => {
    mocks.updateError = { code: 'PGRST204', message: 'x' };
    await expect(updateBusinessStartAction('2020-05-01')).resolves.toEqual({
      success: false,
      error: 'Ta funkcja czeka jeszcze na aktualizację bazy danych. Spróbuj ponownie później.',
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('wyjątek z odczytu „przed” → { success:false }, bez zapisu i audytu', async () => {
    mocks.beforeError = { code: '500', message: 'boom' };
    await expect(updateBusinessStartAction('2020-05-01')).resolves.toEqual({
      success: false,
      error: 'Nie udało się zapisać daty rozpoczęcia działalności. Spróbuj ponownie.',
    });
    expect(mocks.updates).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('inny błąd zapisu → ogólny komunikat', async () => {
    mocks.updateError = { code: '23514', message: 'x' };
    await expect(updateBusinessStartAction('2020-05-01')).resolves.toEqual({
      success: false,
      error: 'Nie udało się zapisać daty rozpoczęcia działalności.',
    });
  });
  it('sukces → update, audit z from/to, revalidate obu ścieżek', async () => {
    mocks.before = '2019-01-01';
    await expect(updateBusinessStartAction(' 2020-05-01 ')).resolves.toEqual({ success: true, startedOn: '2020-05-01' });
    expect(mocks.updates).toEqual([{ business_started_on: '2020-05-01' }]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.updated',
        tenantId: 'ten-1',
        userId: 'u-1',
        metadata: { field: 'business_started_on', from: '2019-01-01', to: '2020-05-01' },
      }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith('/settings');
    expect(mocks.revalidate).toHaveBeenCalledWith('/dashboard');
  });
  it('null czyści', async () => {
    mocks.before = '2020-05-01';
    await expect(updateBusinessStartAction(null)).resolves.toEqual({ success: true, startedOn: null });
    expect(mocks.updates).toEqual([{ business_started_on: null }]);
  });
});

describe('BusinessStartForm', () => {
  it('pokazuje label, wartość, max i „Wyczyść”', () => {
    const html = renderToStaticMarkup(<BusinessStartForm initialStartedOn="2024-03-01" canEdit today={TODAY} />);
    expect(html).toContain('Data rozpoczęcia działalności');
    expect(html).toContain('for="business-started-on"');
    expect(html).toContain('value="2024-03-01"');
    expect(html).toContain(`max="${TODAY}"`);
    expect(html).toContain('Wyczyść');
    expect(html).toContain('Zapisz');
  });
  it('bez wartości nie ma „Wyczyść”', () => {
    const html = renderToStaticMarkup(<BusinessStartForm initialStartedOn={null} canEdit today={TODAY} />);
    expect(html).not.toContain('Wyczyść');
  });
  it('rola bez uprawnień: pole disabled, komunikat, brak przycisków', () => {
    const html = renderToStaticMarkup(<BusinessStartForm initialStartedOn="2024-03-01" canEdit={false} today={TODAY} />);
    expect(html).toContain('disabled');
    expect(html).toContain('Zmienić to może właściciel albo administrator firmy.');
    expect(html).not.toContain('Zapisz');
    expect(html).not.toContain('Wyczyść');
  });
});

describe('BusinessStartForm — zachowanie', () => {
  let host: HTMLDivElement;
  let root: Root;

  const mount = (initial: string | null) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<BusinessStartForm initialStartedOn={initial} canEdit today={TODAY} />));
  };
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const input = () => host.querySelector('input') as HTMLInputElement;
  const button = (label: string) =>
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

  /** Ustawia value (albo badInput) i wywołuje onChange Reacta. */
  const type = (value: string, badInput = false) => {
    const el = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    Object.defineProperty(el, 'validity', { configurable: true, value: { badInput } });
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const click = async (label: string) => {
    await act(async () => {
      button(label).click();
    });
  };

  it('niepełna data (badInput) → błąd formatu, akcja niewołana', async () => {
    mount('2024-03-01');
    type('', true);
    await click('Zapisz');
    expect(host.textContent).toContain('Podaj datę w formacie DD.MM.RRRR.');
    expect(mocks.actionSpy).not.toHaveBeenCalled();
  });
  it('puste pole przy zapisanej dacie: „Zapisz” nie czyści', async () => {
    mount('2024-03-01');
    type('');
    await click('Zapisz');
    expect(host.textContent).toContain('Pole jest puste. Żeby usunąć datę, użyj „Wyczyść”.');
    expect(mocks.actionSpy).not.toHaveBeenCalled();
  });
  it('„Wyczyść” wysyła null', async () => {
    mount('2024-03-01');
    await click('Wyczyść');
    expect(mocks.actionSpy).toHaveBeenCalledWith(null);
  });
  it('bez zmiany (puste bez zapisanej daty, ta sama data) → akcja niewołana, bez audytu „null → null”', async () => {
    mount(null);
    await click('Zapisz');
    expect(mocks.actionSpy).not.toHaveBeenCalled();
    act(() => root.unmount());
    host.remove();
    mount('2024-03-01');
    type('2024-03-01');
    await click('Zapisz');
    expect(mocks.actionSpy).not.toHaveBeenCalled();
  });
  it('poprawna data → akcja z datą', async () => {
    mount('2024-03-01');
    type('2020-05-01');
    await click('Zapisz');
    expect(mocks.actionSpy).toHaveBeenCalledWith('2020-05-01');
  });
});
