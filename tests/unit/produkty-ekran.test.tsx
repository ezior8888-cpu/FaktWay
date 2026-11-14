// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ekran katalogu produktów i usług (krok 2.6, część 1): lista z sesji,
 * szukanie i „pokaż zarchiwizowane” w adresie, błąd odczytu jako komunikat
 * (nie pusta lista), usuwanie tylko przy use_count = 0.
 */

// Zwykła funkcja, nie vi.fn: odrzucenie z vi.fn zgłaszał runner jako niewyłapany błąd testu.
const m = vi.hoisted(() => {
  const state: { impl: () => Promise<unknown>; calls: unknown[][] } = { impl: async () => [], calls: [] };
  return { state, list: (...args: unknown[]) => (state.calls.push(args), state.impl()) };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({ supabase: {}, tenantId: 'T1', user: { id: 'u' }, role: 'owner' }),
}));
vi.mock('@/lib/produkty/baza', () => ({ listProducts: m.list }));
vi.mock('@/app/actions/produkty', () => ({
  createProductAction: vi.fn(),
  updateProductAction: vi.fn(),
  archiveProductAction: vi.fn(),
  restoreProductAction: vi.fn(),
  deleteProductAction: vi.fn(),
}));

import ProductsPage from '@/app/(dashboard)/produkty/page';
import { ProductsList } from '@/app/(dashboard)/produkty/_components/products-list';
import type { ProductListItem } from '@/lib/produkty/model';

const plain = (html: string) => html.replace(/[  ]/g, ' ').replace(/&quot;/g, '"');
const item = (extra: Partial<ProductListItem> = {}): ProductListItem => ({
  id: 'p1', name: 'Szkolenie', unit: 'godz.', defaultPriceNet: 1250.5, defaultVatRate: '23', pkwiuCode: null, gtuCode: null, description: null, isArchived: false, useCount: 0, lastUsedAt: null, ...extra,
});

async function render(sp: Record<string, string> = {}) {
  const el = await ProductsPage({ searchParams: Promise.resolve(sp) });
  return plain(renderToStaticMarkup(el));
}

beforeEach(() => {
  m.state.calls = [];
});

describe('strona Produkty i usługi', () => {
  it('wołana z {} pokazuje listę aktywnych i nagłówek', async () => {
    m.state.impl = async () => [item()];
    const html = await render();
    expect(html).toContain('Produkty i usługi');
    expect(html).toContain('Szkolenie');
    expect(html).toContain('1250,50');
    expect(m.state.calls[0].slice(1)).toEqual(['T1', { q: '', archived: false }]);
  });

  it('szukanie i zarchiwizowane przechodzą do odczytu', async () => {
    m.state.impl = async () => [];
    await render({ q: 'szkol', zarchiwizowane: '1' });
    expect(m.state.calls[0].slice(1)).toEqual(['T1', { q: 'szkol', archived: true }]);
  });

  it('błąd odczytu to komunikat, nie pusta lista', async () => {
    m.state.impl = async () => {
      throw new Error('boom');
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const html = await render();
    expect(html).toContain('Nie udało się wczytać produktów');
    expect(html).not.toContain('Nie masz jeszcze');
  });

  it('pusty katalog podpowiada pierwsze dodanie', async () => {
    m.state.impl = async () => [];
    expect(await render()).toContain('Nie masz jeszcze produktów');
  });
});

describe('ProductsList', () => {
  it('przycisk usuń tylko przy use_count = 0, użyty ma tylko archiwizację', () => {
    const unused = plain(renderToStaticMarkup(<ProductsList rows={[item()]} />));
    expect(unused).toContain('Usuń');
    const used = plain(renderToStaticMarkup(<ProductsList rows={[item({ useCount: 4 })]} />));
    expect(used).not.toContain('Usuń');
    expect(used).toContain('Zarchiwizuj');
  });

  it('zarchiwizowany ma „Przywróć”', () => {
    const html = plain(renderToStaticMarkup(<ProductsList rows={[item({ isArchived: true })]} />));
    expect(html).toContain('Przywróć');
    expect(html).not.toContain('Zarchiwizuj');
  });
});
