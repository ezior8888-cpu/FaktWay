import { UPLOAD_FAILED_MESSAGE } from '@/lib/upload-limit';

/**
 * Wysyłka pliku z przeglądarki do trasy wgrywania (plan skalowania, sesja 31):
 * `/api/uploads/expense` i `/api/uploads/import` zamiast Server Actions, które
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

export type ExpenseUploadResult = { success: true; ocrJobId: string } | { success: false; error: string };
export type ImportUploadResult = { success: true; importJobId: string } | { success: false; error: string };

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
