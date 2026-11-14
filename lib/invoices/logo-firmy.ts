import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';

import { logAudit } from '@/lib/audit/log';
import { prepareLogoUpload } from '@/lib/pdf/logo-obraz';
import {
  LOGO_CONTENT_TYPE,
  deleteTenantLogo,
  isTenantLogoKey,
  logoFormatOfKey,
  newTenantLogoKey,
  putTenantLogo,
  sweepTenantLogos,
  tenantLogoExists,
} from '@/lib/storage/logo';
import { getSignedFileUrl } from '@/lib/storage/signed-file-url';
import { createAdminClient } from '@/lib/supabase/admin';
import { tenantChangedMessage, type AuthContext, type UserRole } from '@/lib/supabase/auth-context';
import { formatUploadSize, LOGO_FILE_LIMIT_BYTES, LOGO_FILE_LIMIT_LABEL } from '@/lib/upload-limit';
import type { CompanyLogoView, UploadedLogo } from '@/lib/uploads/client';

export type { CompanyLogoView };

/**
 * Logo firmy w ustawieniach (plan kompletnej aplikacji, krok 2.2, część 1):
 * wgranie, zmiana, usunięcie i podgląd. Woła je trasa `/api/uploads/logo`
 * (po bramce `lib/uploads/server.ts`: Origin, rozmiar, sesja, 2FA, firma,
 * limit) i akcja `deleteCompanyLogoAction`. NIE eksportuj tego z pliku
 * `'use server'`: każdy taki eksport to publiczna końcówka.
 *
 * Zmienia właściciel i administrator, jak dane firmy (`updateCompanyProfileAction`).
 * Zapis wskaźnika `tenants.logo_storage_key` kluczem serwisowym po sprawdzeniu
 * roli; sesji klienta zmianę kolumny odrzuca wyzwalacz z 00202. Audyt:
 * `tenant.updated` z `metadata.field = 'logo'`, jak inne ustawienia firmy.
 *
 * Ponowienie od zera (protokół, pkt 5) i pliki w magazynie:
 *  Wgranie: (1) odczyt bieżącego klucza: bez skutków; (2) plik pod NOWYM
 *  kluczem z UUID (`IfNoneMatch`), więc każda próba ma swój plik; (3) wskaźnik
 *  w bazie z warunkiem „klucz się nie zmienił”; przy błędzie albo zmianie
 *  w międzyczasie plik tej próby jest od razu usuwany, a ponowienie zaczyna
 *  od nowa i nie zostawia sieroty; (4) audyt; (5) usunięcie starego pliku;
 *  (6) sprzątanie katalogu logo firmy z plików starszych niż 15 minut innych
 *  niż bieżący (sieroty po nieudanym kroku 3 albo 5). Błąd kroku 5 lub 6
 *  nie cofa zmiany: następna zmiana logo sprząta.
 *  Usunięcie: najpierw plik, potem wskaźnik (pliki przed wierszami, AUD-45).
 *  Błąd bazy po usunięciu pliku: ponowienie usuwa już nieistniejący plik
 *  (sukces) i czyści wskaźnik. Logo bez wskaźnika: sukces bez zmian.
 */

export const LOGO_EDIT_ROLES: readonly UserRole[] = ['owner', 'admin'];

export const LOGO_ROLE_MESSAGE = 'Logo zmienia właściciel albo administrator firmy.';

/** Ważność podpisanego adresu podglądu (jak zdjęcie kosztu: krótko, strona i tak jest dynamiczna). */
const PREVIEW_SECONDS = 600;

export const COMPANY_LOGO_TEXTS = {
  noFile: 'Brak pliku logo. Wybierz plik PNG albo JPEG.',
  tooLarge: (bytes: number) => `Plik ma ${formatUploadSize(bytes)}, a logo może mieć najwyżej ${LOGO_FILE_LIMIT_LABEL}.`,
  saveFailed: 'Nie udało się zapisać logo. Spróbuj ponownie.',
  readFailed: 'Nie udało się odczytać logo firmy. Odśwież stronę i spróbuj ponownie.',
  databasePending: 'Logo czeka jeszcze na aktualizację bazy danych. Spróbuj ponownie później.',
  conflict: 'Logo zmieniło się w międzyczasie, np. w innej karcie. Odśwież stronę i spróbuj ponownie.',
  removeFailed: 'Nie udało się usunąć pliku logo. Spróbuj ponownie.',
  removeNotSaved: 'Plik logo jest już usunięty, ale zmiana się nie zapisała. Spróbuj ponownie.',
} as const;

export type CompanyLogoUploadOutcome =
  | { success: true; logo: UploadedLogo }
  | { success: false; status: number; error: string };

export type CompanyLogoRemoveOutcome = { success: true } | { success: false; error: string };

type AdminClient = ReturnType<typeof createAdminClient>;
type CurrentKey = { ok: true; key: string | null } | { ok: false; missingColumn: boolean };
type Swap = 'ok' | 'conflict' | 'missing_column' | 'error';

function isMissingColumn(code: string | undefined): boolean {
  return code === '42703' || code === 'PGRST204';
}

function report(step: string, error: unknown, tenantId: string): void {
  console.error(`[logo-firmy] ${step}`, { tenantId, reason: error instanceof Error ? error.message : 'unknown' });
  Sentry.captureException(error, { tags: { area: 'company-logo', step } });
}

async function readCurrentKey(admin: AdminClient, tenantId: string): Promise<CurrentKey> {
  const { data, error } = await admin.from('tenants').select('logo_storage_key').eq('id', tenantId).maybeSingle();
  if (error) return { ok: false, missingColumn: isMissingColumn(error.code) };
  if (!data) return { ok: false, missingColumn: false };
  const key = (data as { logo_storage_key?: unknown }).logo_storage_key;
  return { ok: true, key: typeof key === 'string' && key ? key : null };
}

/** Zmiana wskaźnika tylko wtedy, gdy w bazie jest wciąż `from` (druga karta nie zostaje nadpisana). */
async function swapKey(admin: AdminClient, tenantId: string, from: string | null, to: string | null): Promise<Swap> {
  const update = admin.from('tenants').update({ logo_storage_key: to }).eq('id', tenantId);
  const guarded = from === null ? update.is('logo_storage_key', null) : update.eq('logo_storage_key', from);
  const { data, error } = await guarded.select('id');
  if (error) return isMissingColumn(error.code) ? 'missing_column' : 'error';
  return Array.isArray(data) && data.length === 1 ? 'ok' : 'conflict';
}

async function previewUrl(key: string, tenantId: string): Promise<string | null> {
  try {
    return await getSignedFileUrl(key, tenantId, {
      expiresInSeconds: PREVIEW_SECONDS,
      contentType: LOGO_CONTENT_TYPE[logoFormatOfKey(key)],
      contentDisposition: 'inline',
    });
  } catch (error) {
    report('preview_url', error, tenantId);
    return null;
  }
}

function fail(status: number, error: string): CompanyLogoUploadOutcome {
  return { success: false, status, error };
}

/** Wgranie albo zmiana logo z pola `logo` formularza (z polem `tenantId` firmy formularza). */
export async function acceptCompanyLogoUpload(
  ctx: Pick<AuthContext, 'tenantId' | 'user'>,
  form: FormData,
): Promise<CompanyLogoUploadOutcome> {
  const { tenantId } = ctx;
  const file = form.get('logo');
  if (!(file instanceof File)) return fail(400, COMPANY_LOGO_TEXTS.noFile);
  // UX-01: formularz wyrenderowany dla innej firmy niż aktywna teraz.
  if (form.get('tenantId') !== tenantId) return fail(409, tenantChangedMessage(null));
  if (file.size > LOGO_FILE_LIMIT_BYTES) return fail(413, COMPANY_LOGO_TEXTS.tooLarge(file.size));

  const checked = prepareLogoUpload(new Uint8Array(await file.arrayBuffer()));
  if (!checked.ok) return fail(checked.reason === 'too_large' ? 413 : 422, checked.error);
  const { logo } = checked;

  const admin = createAdminClient();
  const current = await readCurrentKey(admin, tenantId);
  if (!current.ok) return fail(503, current.missingColumn ? COMPANY_LOGO_TEXTS.databasePending : COMPANY_LOGO_TEXTS.saveFailed);

  const key = newTenantLogoKey(tenantId, logo.format);
  try {
    await putTenantLogo(key, tenantId, logo.data, logo.format);
  } catch (error) {
    report('put', error, tenantId);
    return fail(503, COMPANY_LOGO_TEXTS.saveFailed);
  }

  const swap = await swapKey(admin, tenantId, current.key, key);
  if (swap !== 'ok') {
    // Plik tej próby nie ma wskaźnika: usuwamy go od razu (bez sieroty po ponowieniu).
    await deleteTenantLogo(key, tenantId).catch((error: unknown) => report('compensate', error, tenantId));
    if (swap === 'conflict') return fail(409, COMPANY_LOGO_TEXTS.conflict);
    return fail(503, swap === 'missing_column' ? COMPANY_LOGO_TEXTS.databasePending : COMPANY_LOGO_TEXTS.saveFailed);
  }

  await logAudit({
    action: 'tenant.updated',
    tenantId,
    userId: ctx.user.id,
    entityType: 'tenant',
    entityId: tenantId,
    metadata: {
      field: 'logo',
      change: current.key ? 'replaced' : 'added',
      from: current.key,
      to: key,
      format: logo.format,
      width: logo.width,
      height: logo.height,
      bytes: logo.data.length,
    },
  });

  if (current.key && isTenantLogoKey(current.key, tenantId)) {
    await deleteTenantLogo(current.key, tenantId).catch((error: unknown) => report('delete_previous', error, tenantId));
  }
  await sweepTenantLogos(tenantId, key).catch((error: unknown) => report('sweep', error, tenantId));

  revalidatePath('/settings');
  return {
    success: true,
    logo: { previewUrl: await previewUrl(key, tenantId), format: logo.format, width: logo.width, height: logo.height },
  };
}

/** Usunięcie logo: plik z magazynu, potem wskaźnik w bazie, audyt i sprzątanie katalogu. */
export async function removeCompanyLogo(ctx: Pick<AuthContext, 'tenantId' | 'user'>): Promise<CompanyLogoRemoveOutcome> {
  const { tenantId } = ctx;
  const admin = createAdminClient();
  const current = await readCurrentKey(admin, tenantId);
  if (!current.ok) {
    return { success: false, error: current.missingColumn ? COMPANY_LOGO_TEXTS.databasePending : COMPANY_LOGO_TEXTS.readFailed };
  }
  if (!current.key) return { success: true };

  if (isTenantLogoKey(current.key, tenantId)) {
    try {
      await deleteTenantLogo(current.key, tenantId);
    } catch (error) {
      report('delete', error, tenantId);
      return { success: false, error: COMPANY_LOGO_TEXTS.removeFailed };
    }
  }

  const swap = await swapKey(admin, tenantId, current.key, null);
  if (swap === 'conflict') {
    // Ktoś usunął logo równolegle (sukces) albo wgrał nowe (zostaje).
    const again = await readCurrentKey(admin, tenantId);
    return again.ok && again.key === null ? { success: true } : { success: false, error: COMPANY_LOGO_TEXTS.conflict };
  }
  if (swap !== 'ok') {
    return { success: false, error: swap === 'missing_column' ? COMPANY_LOGO_TEXTS.databasePending : COMPANY_LOGO_TEXTS.removeNotSaved };
  }

  await logAudit({
    action: 'tenant.updated',
    tenantId,
    userId: ctx.user.id,
    entityType: 'tenant',
    entityId: tenantId,
    metadata: { field: 'logo', change: 'removed', from: current.key, to: null },
  });
  await sweepTenantLogos(tenantId, null).catch((error: unknown) => report('sweep', error, tenantId));

  revalidatePath('/settings');
  return { success: true };
}

interface TenantsReader {
  from: (table: 'tenants') => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
      };
    };
  };
}

/**
 * Stan logo do ustawień, klientem z sesji (RLS i GRANT SELECT z 00202):
 * podpisany adres podglądu tylko dla klucza z katalogu logo tej firmy i tylko,
 * gdy plik jest w magazynie.
 */
export async function readCompanyLogoForSettings(client: unknown, tenantId: string): Promise<CompanyLogoView> {
  let key: unknown;
  try {
    const { data, error } = await (client as TenantsReader)
      .from('tenants')
      .select('logo_storage_key')
      .eq('id', tenantId)
      .maybeSingle();
    if (error) return { status: 'unavailable' };
    key = (data as { logo_storage_key?: unknown } | null)?.logo_storage_key;
  } catch {
    return { status: 'unavailable' };
  }
  if (key === null || key === undefined || key === '') return { status: 'none' };
  if (!isTenantLogoKey(key, tenantId)) return { status: 'missing' };
  try {
    if (!(await tenantLogoExists(key, tenantId))) return { status: 'missing' };
  } catch {
    return { status: 'unavailable' };
  }
  return { status: 'ok', format: logoFormatOfKey(key), previewUrl: await previewUrl(key, tenantId) };
}
