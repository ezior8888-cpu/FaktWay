'use server';

import { revalidatePath } from 'next/cache';

import { logAudit, type AuditAction } from '@/lib/audit/log';
import { suggestProducts } from '@/lib/produkty/baza';
import {
  duplicateProductMessage,
  productFormSchema,
  type ProductFormInput,
  type ProductSuggestion,
} from '@/lib/produkty/model';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

export type ProductActionResult = { success: true; id?: string } | { success: false; error: string };

/** Księgowa ma wgląd; katalog zmieniają pozostali członkowie (jak kontrahentów). */
const EDITOR_ROLES = ['owner', 'admin', 'member'] as const;
/** Podpowiedź tylko czyta katalog, więc dostaje ją każdy członek firmy. */
const READER_ROLES = ['owner', 'admin', 'member', 'accountant'] as const;

const NOT_FOUND = 'Nie znaleziono produktu w tej organizacji.';
/** Kod Postgresa dla naruszenia unikalnego klucza (nazwa + jednostka, 00186). */
const UNIQUE_VIOLATION = '23505';

async function context() {
  try {
    return { ctx: await requireOrgRole([...EDITOR_ROLES]) };
  } catch (e) {
    if (e instanceof ActionAuthError) return { error: e.message };
    throw e;
  }
}

const COLUMNS = 'id, name, unit, default_price_net, default_vat_rate, pkwiu_code, gtu_code, description, use_count';

function columnsOf(d: ReturnType<typeof productFormSchema.parse>) {
  return {
    name: d.name,
    unit: d.unit,
    default_price_net: d.defaultPriceNet,
    default_vat_rate: d.defaultVatRate,
    pkwiu_code: d.pkwiuCode,
    gtu_code: d.gtuCode,
    description: d.description,
  };
}

/** Dodanie produktu do katalogu firmy. Dubel nazwy i jednostki to komunikat z nazwą produktu. */
export async function createProductAction(input: ProductFormInput): Promise<ProductActionResult> {
  const c = await context();
  if (!c.ctx) return { success: false, error: c.error };
  const parsed = productFormSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Nieprawidłowe dane produktu.' };

  const { supabase, tenantId, user } = c.ctx;
  const { data, error } = await supabase
    .from('products')
    .insert({ tenant_id: tenantId, ...columnsOf(parsed.data) })
    .select('id');
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { success: false, error: duplicateProductMessage(parsed.data.name, parsed.data.unit) };
    }
    return { success: false, error: 'Nie udało się zapisać produktu. Spróbuj ponownie.' };
  }
  const id = (data as Array<{ id: string }> | null)?.[0]?.id;
  await logAudit({
    action: 'product.created',
    tenantId,
    userId: user.id,
    entityType: 'product',
    entityId: id,
    metadata: { name: parsed.data.name, unit: parsed.data.unit },
  });
  revalidatePath('/produkty');
  return { success: true, id };
}

/** Edycja produktu; do audytu trafiają nazwy zmienionych pól. */
export async function updateProductAction(productId: string, input: ProductFormInput): Promise<ProductActionResult> {
  const c = await context();
  if (!c.ctx) return { success: false, error: c.error };
  const parsed = productFormSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Nieprawidłowe dane produktu.' };

  const { supabase, tenantId, user } = c.ctx;
  const { data: current, error: readError } = await supabase
    .from('products')
    .select(COLUMNS)
    .eq('id', productId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (readError || !current) return { success: false, error: NOT_FOUND };

  const next = columnsOf(parsed.data);
  const before = current as unknown as Record<string, unknown>;
  const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
    (k) => (before[k] ?? null) !== next[k],
  );
  if (changed.length === 0) return { success: true, id: productId };

  const { data: updated, error } = await supabase
    .from('products')
    .update(next)
    .eq('id', productId)
    .eq('tenant_id', tenantId)
    .select('id');
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { success: false, error: duplicateProductMessage(parsed.data.name, parsed.data.unit) };
    }
    return { success: false, error: 'Nie udało się zapisać produktu. Spróbuj ponownie.' };
  }
  if (!updated || updated.length === 0) return { success: false, error: NOT_FOUND };

  await logAudit({
    action: 'product.updated',
    tenantId,
    userId: user.id,
    entityType: 'product',
    entityId: productId,
    metadata: { fields: changed },
  });
  revalidatePath('/produkty');
  return { success: true, id: productId };
}

async function setArchived(productId: string, archived: boolean): Promise<ProductActionResult> {
  const c = await context();
  if (!c.ctx) return { success: false, error: c.error };
  const { supabase, tenantId, user } = c.ctx;
  const { data, error } = await supabase
    .from('products')
    .update({ is_archived: archived })
    .eq('id', productId)
    .eq('tenant_id', tenantId)
    .select('id');
  if (error) {
    return { success: false, error: archived ? 'Nie udało się zarchiwizować produktu.' : 'Nie udało się przywrócić produktu.' };
  }
  if (!data || data.length === 0) return { success: false, error: NOT_FOUND };

  const action: AuditAction = archived ? 'product.archived' : 'product.restored';
  await logAudit({ action, tenantId, userId: user.id, entityType: 'product', entityId: productId });
  revalidatePath('/produkty');
  return { success: true, id: productId };
}

/** Archiwizacja: produkt znika z podpowiedzi, historia faktur zostaje. */
export async function archiveProductAction(productId: string): Promise<ProductActionResult> {
  return setArchived(productId, true);
}

/** Przywrócenie produktu z archiwum. */
export async function restoreProductAction(productId: string): Promise<ProductActionResult> {
  return setArchived(productId, false);
}

/**
 * Usunięcie tylko produktu nieużytego (`use_count = 0`, pomyłka przy dodaniu).
 * Warunek jest też w samym DELETE, więc użycie między odczytem a usunięciem
 * (np. import) nie kasuje produktu z historią.
 */
export async function deleteProductAction(productId: string): Promise<ProductActionResult> {
  const c = await context();
  if (!c.ctx) return { success: false, error: c.error };
  const { supabase, tenantId, user } = c.ctx;

  const { data: current, error: readError } = await supabase
    .from('products')
    .select('id, name, unit, use_count')
    .eq('id', productId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (readError || !current) return { success: false, error: NOT_FOUND };

  const row = current as { name: string; unit: string; use_count: number | null };
  if ((row.use_count ?? 0) > 0) {
    return {
      success: false,
      error: `Produkt „${row.name}” był użyty na fakturach (${row.use_count} razy), więc nie można go usunąć. Zarchiwizuj go: zniknie z podpowiedzi, a historia zostanie.`,
    };
  }

  const { data: deleted, error } = await supabase
    .from('products')
    .delete()
    .eq('id', productId)
    .eq('tenant_id', tenantId)
    .eq('use_count', 0)
    .select('id');
  if (error) return { success: false, error: 'Nie udało się usunąć produktu.' };
  if (!deleted || deleted.length === 0) {
    return { success: false, error: `Produkt „${row.name}” został użyty przed chwilą i nie został usunięty. Zarchiwizuj go.` };
  }

  await logAudit({
    action: 'product.deleted',
    tenantId,
    userId: user.id,
    entityType: 'product',
    entityId: productId,
    metadata: { name: row.name, unit: row.unit },
  });
  revalidatePath('/produkty');
  return { success: true, id: productId };
}

export type ProductSuggestResult = { ok: true; items: ProductSuggestion[] } | { ok: false };

/**
 * Podpowiedź produktów przy nazwie pozycji faktury (plan kompletnej
 * aplikacji, krok 2.6, część 2a). Firma z sesji, odczyt przez RLS (00013).
 * Błąd sesji albo bazy to `ok: false` bez wyjątku: formularz pokazuje krótką
 * informację, a nazwę pozycji dalej można wpisać ręcznie.
 */
export async function suggestProductsAction(query: string): Promise<ProductSuggestResult> {
  if (typeof query !== 'string') return { ok: true, items: [] };
  try {
    const { supabase, tenantId } = await requireOrgRole([...READER_ROLES]);
    // Fraza ma najwyżej 100 znaków (`suggestProducts`); dłuższe wejście nie idzie dalej.
    return { ok: true, items: await suggestProducts(supabase, tenantId, query.slice(0, 200)) };
  } catch (e) {
    if (!(e instanceof ActionAuthError)) {
      console.error('[produkty] podpowiedź katalogu:', e instanceof Error ? e.message : e);
    }
    return { ok: false };
  }
}
