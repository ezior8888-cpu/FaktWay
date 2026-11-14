import { UPLOAD_FAILED_MESSAGE } from '@/lib/upload-limit';

/**
 * Wysyłka pliku z przeglądarki do trasy wgrywania (plan skalowania, sesja 31):
 * `/api/uploads/expense`, `/api/uploads/import` i `/api/uploads/logo` (logo
 * firmy, plan kompletnej aplikacji, krok 2.2) zamiast Server Actions, które
 * przyjmują najwyżej 1 MiB ciała. Trasa odpowiada JSON-em
 * `{ success: true, … }` albo `{ success: false, error }` z polskim
 * komunikatem — także przy odmowie (413, 429, 401).
 *
 * Funkcje nigdy nie odrzucają obietnicy: sieć, odpowiedź bez JSON (bramka,
 * restart serwera) i sukces bez identyfikatora zadania kończą się
 * `UPLOAD_FAILED_MESSAGE`. Odrzucona obietnica w `startTransition` trafiłaby
 * do granicy błędu strony zamiast do toastu.
 *
 * Tylko API przeglądarki — moduł dla komponentów klienckich.
 */

export const EXPENSE_UPLOAD_URL = '/api/uploads/expense';
export const IMPORT_UPLOAD_URL = '/api/uploads/import';
export const LOGO_UPLOAD_URL = '/api/uploads/logo';

export type ExpenseUploadResult = { success: true; ocrJobId: string } | { success: false; error: string };
export type ImportUploadResult = { success: true; importJobId: string } | { success: false; error: string };

/** Logo firmy zapisane przez `/api/uploads/logo` (krok 2.2); podgląd `null`, gdy adresu nie udało się podpisać. */
export interface UploadedLogo {
  previewUrl: string | null;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
}
export type LogoUploadResult = { success: true; logo: UploadedLogo } | { success: false; error: string };

/** Stan logo w sekcji ustawień (czyta go `readCompanyLogoForSettings` w `lib/invoices/logo-firmy.ts`). */
export type CompanyLogoView =
  | { status: 'none' }
  | { status: 'ok'; previewUrl: string | null; format: 'png' | 'jpeg' }
  /** Wskaźnik w bazie jest, pliku w magazynie nie ma: wydruk bez logo. */
  | { status: 'missing' }
  /** Odczyt się nie udał (albo przed migracją 00203). */
  | { status: 'unavailable' };

type Failure = { success: false; error: string };

function failed(): Failure {
  return { success: false, error: UPLOAD_FAILED_MESSAGE };
}

async function postForm(url: string, form: FormData): Promise<{ ok: true; body: Record<string, unknown> } | Failure> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    console.error('[wgrywanie] żądanie nie doszło do serwera', error);
    return failed();
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    console.error('[wgrywanie] odpowiedź bez JSON', res.status);
    return failed();
  }
  if (!body || typeof body !== 'object') return failed();
  const record = body as Record<string, unknown>;
  if (record.success === false) {
    return typeof record.error === 'string' && record.error.trim() ? { success: false, error: record.error } : failed();
  }
  return res.ok && record.success === true ? { ok: true, body: record } : failed();
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Zdjęcie albo PDF kosztu w polu `photo`. */
export async function postExpenseUpload(form: FormData): Promise<ExpenseUploadResult> {
  const result = await postForm(EXPENSE_UPLOAD_URL, form);
  if (!('ok' in result)) return result;
  return nonEmptyString(result.body.ocrJobId) ? { success: true, ocrJobId: result.body.ocrJobId } : failed();
}

/** CSV importu w polu `file` z `source` i `tenantId`. */
export async function postImportUpload(form: FormData): Promise<ImportUploadResult> {
  const result = await postForm(IMPORT_UPLOAD_URL, form);
  if (!('ok' in result)) return result;
  return nonEmptyString(result.body.importJobId) ? { success: true, importJobId: result.body.importJobId } : failed();
}

function uploadedLogo(value: unknown): UploadedLogo | null {
  if (!value || typeof value !== 'object') return null;
  const logo = value as Record<string, unknown>;
  const format = logo.format === 'png' || logo.format === 'jpeg' ? logo.format : null;
  const size = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null);
  const width = size(logo.width);
  const height = size(logo.height);
  if (!format || !width || !height) return null;
  return { format, width, height, previewUrl: nonEmptyString(logo.previewUrl) ? logo.previewUrl : null };
}

/** Logo firmy w polu `logo` z `tenantId` (Ustawienia → Firma). */
export async function postLogoUpload(form: FormData): Promise<LogoUploadResult> {
  const result = await postForm(LOGO_UPLOAD_URL, form);
  if (!('ok' in result)) return result;
  const logo = uploadedLogo(result.body.logo);
  return logo ? { success: true, logo } : failed();
}
