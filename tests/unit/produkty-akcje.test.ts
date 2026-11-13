import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * Akcje katalogu produktów (krok 2.6, część 1): dodanie, edycja, archiwizacja,
 * przywrócenie, usunięcie (tylko przy use_count = 0), dubel z indeksu 00186
 * jako komunikat po polsku i audyt każdej zmiany. Atrapy tylko dla sesji
 * i bazy (w pamięci); RLS i unikalność na prawdziwej bazie: migracje 00013/00186.
 */

const TENANT = 'ten-1';
const P1 = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), audit: vi.fn(), revalidate: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireOrgRole: mocks.auth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));

import {
  archiveProductAction,
  createProductAction,
  deleteProductAction,
  restoreProductAction,
  updateProductAction,
} from '@/app/actions/produkty';
import type { ProductFormInput } from '@/lib/produkty/model';
import { ActionAuthError } from '@/lib/supabase/auth-context';

let db: MemoryDb;

const INPUT: ProductFormInput = { name: 'Szkolenie', unit: 'godz.', priceNet: '150,00', vatRate: '23', pkwiu: '', gtu: '', description: '' };

function produkt(extra: Row = {}): Row {
  return { id: P1, tenant_id: TENANT, name: 'Szkolenie', unit: 'godz.', default_price_net: 150, default_vat_rate: '23', pkwiu_code: null, gtu_code: null, description: null, is_archived: false, use_count: 0, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  db = memoryDb({ products: [] });
  mocks.auth.mockResolvedValue({ supabase: fakeSupabase(db), tenantId: TENANT, user: { id: 'u1' }, role: 'member' });
});

describe('createProductAction', () => {
  it('zapisuje produkt firmy z sesji i audytuje', async () => {
    const r = await createProductAction(INPUT);
    expect(r.success).toBe(true);
    expect(db.tables.products).toHaveLength(1);
    expect(db.tables.products[0]).toMatchObject({ tenant_id: TENANT, name: 'Szkolenie', unit: 'godz.', default_price_net: 150, default_vat_rate: '23', pkwiu_code: null, gtu_code: null });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'product.created', tenantId: TENANT, userId: 'u1', entityType: 'product' }));
  });

  it('odrzuca zły schemat bez dotykania bazy', async () => {
    const r = await createProductAction({ ...INPUT, priceNet: '-5' });
    expect(r).toMatchObject({ success: false });
    expect(db.touched).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('dubel nazwy i jednostki (23505) to komunikat z nazwą produktu, nie błąd bazy', async () => {
    db.failures['products:insert'] = { code: '23505', message: 'duplicate key value violates unique constraint "uq_products_tenant_catalog_key"' };
    const r = await createProductAction(INPUT);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toContain('Szkolenie');
      expect(r.error).not.toMatch(/duplicate|constraint|uq_products/);
    }
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('brak uprawnień (księgowa) to odmowa z komunikatem', async () => {
    mocks.auth.mockRejectedValue(new ActionAuthError('Niewystarczające uprawnienia'));
    expect(await createProductAction(INPUT)).toEqual({ success: false, error: 'Niewystarczające uprawnienia' });
  });
});

describe('updateProductAction', () => {
  it('zmienia pola i audytuje nazwy zmienionych pól', async () => {
    db.tables.products = [produkt()];
    const r = await updateProductAction(P1, { ...INPUT, priceNet: '200', vatRate: '8' });
    expect(r.success).toBe(true);
    expect(db.tables.products[0]).toMatchObject({ default_price_net: 200, default_vat_rate: '8' });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'product.updated', entityId: P1, metadata: { fields: ['default_price_net', 'default_vat_rate'] } }));
  });

  it('bez zmian nie zapisuje i nie audytuje', async () => {
    db.tables.products = [produkt()];
    expect((await updateProductAction(P1, INPUT)).success).toBe(true);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('cudzy produkt to „nie znaleziono”', async () => {
    db.tables.products = [produkt({ tenant_id: 'ten-2' })];
    const r = await updateProductAction(P1, INPUT);
    expect(r).toMatchObject({ success: false });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('zmiana na zajętą nazwę (23505) to komunikat po polsku', async () => {
    db.tables.products = [produkt()];
    db.failures['products:update'] = { code: '23505', message: 'duplicate key' };
    const r = await updateProductAction(P1, { ...INPUT, name: 'Inne' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('Inne');
  });
});

describe('archiwizacja i przywrócenie', () => {
  it('archiwizuje i przywraca z audytem', async () => {
    db.tables.products = [produkt()];
    expect((await archiveProductAction(P1)).success).toBe(true);
    expect(db.tables.products[0].is_archived).toBe(true);
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'product.archived' }));
    expect((await restoreProductAction(P1)).success).toBe(true);
    expect(db.tables.products[0].is_archived).toBe(false);
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'product.restored' }));
  });

  it('cudzy produkt nie jest archiwizowany', async () => {
    db.tables.products = [produkt({ tenant_id: 'ten-2' })];
    expect((await archiveProductAction(P1)).success).toBe(false);
    expect(db.tables.products[0].is_archived).toBe(false);
  });
});

describe('deleteProductAction', () => {
  it('usuwa produkt nieużyty (use_count = 0) i audytuje', async () => {
    db.tables.products = [produkt()];
    expect((await deleteProductAction(P1)).success).toBe(true);
    expect(db.tables.products).toHaveLength(0);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'product.deleted', entityId: P1 }));
  });

  it('nie usuwa produktu użytego na fakturach, podpowiada archiwizację', async () => {
    db.tables.products = [produkt({ use_count: 3 })];
    const r = await deleteProductAction(P1);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/Zarchiwizuj/);
    expect(db.tables.products).toHaveLength(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('cudzy produkt to „nie znaleziono”, nic nie ginie', async () => {
    db.tables.products = [produkt({ tenant_id: 'ten-2' })];
    expect((await deleteProductAction(P1)).success).toBe(false);
    expect(db.tables.products).toHaveLength(1);
  });
});
