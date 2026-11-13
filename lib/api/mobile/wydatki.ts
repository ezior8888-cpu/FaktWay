import 'server-only';

import { createHash } from 'node:crypto';

import type { NextResponse } from 'next/server';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import {
  MOBILE_EXPENSE_FILE_FIELD,
  type MobileApiErrorCode,
  type OdczytWydatkuOdpowiedz,
  type WgranieWydatkuOdpowiedz,
  type ZatwierdzenieWydatkuOdpowiedz,
} from '@/lib/api/mobile/kontrakt';
import { MOBILE_UNAVAILABLE, MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { sciezkaPola, zatwierdzenieWydatkuSchema } from '@/lib/api/mobile/schematy';
import { acceptExpenseDocument } from '@/lib/expenses/accept-upload';
import { readOcrJobStatus } from '@/lib/expenses/ocr-status';
import { reviewExpense, type ExpenseReviewContext, type ExpenseReviewRefusal } from '@/lib/expenses/review';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { ocrProcessPhotoRequested } from '@/lib/jobs/events';
import { isUuid } from '@/lib/supabase/active-org';
import {
  checkUploadHeaders,
  checkUploadRate,
  isServerSideRefusal,
  logUploadRefusal,
  readUploadForm,
  reserveUploadBytes,
  uploadCaller,
  type UploadRefusal,
} from '@/lib/uploads/server';

/**
 * Wydatek ze zdjęcia z telefonu (plan aplikacji mobilnej, M9): wgranie
 * zdjęcia albo PDF, stan odczytu (OCR) i opis kosztu. Te same funkcje co
 * strona (`lib/expenses/accept-upload.ts`, `ocr-status.ts`, `review.ts`),
 * na kliencie z tokenem telefonu (RLS jak na stronie).
 *
 * Wgranie (`POST /wydatki/zdjecie`) jest poza proxy (`proxy.ts`, AGENTS.md,
 * niezmiennik 7), więc rozmiar, odczyt ciała i limity robi ta sama bramka co
 * `/api/uploads/expense` (`lib/uploads/server.ts`); sesję, 2FA i firmę bramka
 * API telefonu (`authenticateMobileRequest`), bez sprawdzania Origin (telefon
 * nie ma ciasteczek, więc nie ma czego podrobić z innej strony).
 *
 * Ponowienie wgrania (protokół naprawy, punkt 5). Worker zapisuje z odczytu
 * koszt, który od razu liczy się do KPiR, więc drugi odczyt tego samego
 * zdjęcia to drugi koszt. Klucz z nagłówka `Idempotency-Key` (UUID na jedno
 * zdjęcie) trafia do `mobile_idempotency_keys` (00202) zaraz po zadaniu OCR,
 * przed magazynem i kolejką (`onJobCreated`):
 *  - przed zadaniem: ponowienie wgrywa od nowa (nic nie powstało);
 *  - po zadaniu, przed kluczem (śmierć procesu): zostaje zadanie bez pliku
 *    i bez zdarzenia, które nie da kosztu; ponowienie wgrywa od nowa;
 *  - po kluczu, gdy magazyn albo kolejka padną: wgranie usuwa zadanie, klucz
 *    znika z nim (ON DELETE CASCADE), ponowienie wgrywa od nowa;
 *  - po kluczu, przed plikiem (śmierć procesu): ponowienie po `STALE_UPLOAD_MS`
 *    usuwa zadanie bez pliku (z kluczem) i wgrywa od nowa; wcześniej oddaje
 *    to zadanie, bo pierwsze wgranie może jeszcze trwać;
 *  - po pliku, przed zdarzeniem (śmierć procesu): ponowienie po
 *    `STALE_UPLOAD_MS` zleca odczyt jeszcze raz; job odczytu jest
 *    idempotentny (jeden koszt na zadanie, indeks z 00146);
 *  - po zdarzeniu: ponowienie oddaje to samo zadanie (200, `powtorzenie`);
 *  - ten sam klucz z innym plikiem: 409 `idempotency_conflict`;
 *  - dwa równoległe wgrania z tym samym kluczem: drugie odbija UNIQUE klucza,
 *    usuwa swoje zadanie i oddaje zadanie pierwszego.
 *
 * Opis kosztu (`POST /wydatki/{id}/zatwierdzenie`) to UPDATE wiersza: drugi
 * raz z tą samą treścią zapisuje to samo (kategoria i VAT już są, więc ani
 * reguła, ani odliczenie nie liczą się od nowa), bez klucza.
 */

const UPLOAD_ENDPOINT = 'POST /api/mobile/v1/wydatki/zdjecie';
const ROUTE = '/api/mobile/v1/wydatki/zdjecie';

/**
 * Po tylu milisekundach zadanie bez pliku albo bez odczytu uznajemy za
 * porzucone przez pierwsze wgranie: ciało czyta się przed zadaniem (najwyżej
 * 120 s), po zadaniu zostaje wgranie pliku do magazynu i kolejka, a serwer
 * Node ucina żądanie po 300 s.
 */
export const STALE_UPLOAD_MS = 5 * 60 * 1000;

/** Największa treść opisu kosztu (JSON z kilkunastoma polami i notatką do 10 000 znaków). */
const MAX_REVIEW_BYTES = 64_000;

type Db = ExpenseReviewContext['supabase'];

function dbOf(caller: MobileCaller): Db {
  return caller.db as unknown as Db;
}

function tenantOf(caller: MobileCaller): string {
  if (!caller.org) throw new Error('Trasa wydatków bez firmy (org: required)');
  return caller.org.tenantId;
}

const MISSING_KEY = 'Brak klucza zapisu (Idempotency-Key). Zaktualizuj aplikację FaktWay i spróbuj ponownie.';
const KEY_CONFLICT = 'To zdjęcie zostało już wysłane z innym plikiem. Zrób zdjęcie jeszcze raz.';
const NO_FILE = 'Brak pliku. Zrób zdjęcie albo wybierz plik jeszcze raz.';
const NOT_FOUND_JOB = 'Nie ma tego odczytu w wybranej firmie. Sprawdź listę wydatków.';
const NOT_FOUND_EXPENSE = 'Nie znaleziono tego wydatku w wybranej firmie. Odśwież listę wydatków.';
const SAVE_FAILED = 'Nie udało się zapisać wydatku. Spróbuj ponownie za chwilę.';

/** Kod błędu telefonu dla odmowy bramki wgrań (ta sama treść co na stronie). */
function uploadCode(refusal: UploadRefusal): MobileApiErrorCode {
  switch (refusal.reason) {
    case 'bad_type':
    case 'too_large':
      return 'file_invalid';
    case 'timeout':
    case 'bad_body':
      return 'upload_incomplete';
    case 'rate_limited':
      return 'rate_limited';
    case 'busy':
      return refusal.status === 429 ? 'rate_limited' : 'service_unavailable';
    case 'maintenance':
      return 'maintenance';
    default:
      return 'service_unavailable';
  }
}

function uploadRefusal(refusal: UploadRefusal, headers: Record<string, string>): NextResponse {
  logUploadRefusal(ROUTE, refusal);
  const extra: Record<string, string> = refusal.retryAfter !== undefined ? { 'Retry-After': String(refusal.retryAfter) } : {};
  // Komunikaty bramki mówią „Odśwież stronę”: w aplikacji nie ma czego odświeżać.
  const message = refusal.error.replace('Odśwież stronę i spróbuj ponownie.', 'Spróbuj ponownie.');
  return mobileError(refusal.status, uploadCode(refusal), message, { ...headers, ...extra });
}

function sha256(bytes: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

interface UploadKeyRow {
  request_hash: string;
  ocr_job_id: string | null;
  endpoint: string;
}

async function findKey(db: Db, tenantId: string, userId: string, key: string): Promise<UploadKeyRow | null> {
  const { data, error } = await db
    .from('mobile_idempotency_keys' as never)
    .select('request_hash, ocr_job_id, endpoint')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('idempotency_key', key)
    .maybeSingle();
  if (error) throw new MobileUpstreamError('mobile_idempotency_keys.read');
  return (data as UploadKeyRow | null) ?? null;
}

type KeySave = 'ok' | 'taken' | 'failed';

async function saveKey(db: Db, tenantId: string, userId: string, key: string, hash: string, ocrJobId: string): Promise<KeySave> {
  const { error } = await db.from('mobile_idempotency_keys' as never).insert({
    tenant_id: tenantId,
    user_id: userId,
    idempotency_key: key,
    request_hash: hash,
    endpoint: UPLOAD_ENDPOINT,
    ocr_job_id: ocrJobId,
  } as never);
  if (!error) return 'ok';
  return error.code === '23505' ? 'taken' : 'failed';
}

interface JobRow {
  id: string;
  status: string;
  source_file_path: string;
  created_at: string;
}

async function readJob(db: Db, tenantId: string, ocrJobId: string): Promise<JobRow | null> {
  const { data, error } = await db
    .from('ocr_jobs')
    .select('id, status, source_file_path, created_at')
    .eq('id', ocrJobId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new MobileUpstreamError('ocr_jobs.read');
  return (data as JobRow | null) ?? null;
}

const isStale = (job: JobRow) => Date.now() - new Date(job.created_at).getTime() > STALE_UPLOAD_MS;

/** Wynik ponowienia: zadanie pierwszego wgrania albo „wgraj od nowa” (pierwsze wgranie umarło przed plikiem). */
type Replay = { kind: 'job'; response: NextResponse } | { kind: 'fresh' };

async function replay(caller: MobileCaller, ocrJobId: string): Promise<Replay> {
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const job = await readJob(db, tenantId, ocrJobId);
  // Klucz usuwa się razem z zadaniem (ON DELETE CASCADE): tu zadanie zawsze jest.
  if (!job) throw new MobileUpstreamError('mobile_idempotency_keys.ocr_job');

  if (job.source_file_path === 'pending' && isStale(job)) {
    // Zadanie bez pliku i bez zdarzenia nie da kosztu. Warunek w DELETE: gdyby
    // pierwsze wgranie jednak zapisało plik, wiersz zostaje i oddajemy zadanie.
    const { data, error } = await db
      .from('ocr_jobs')
      .delete()
      .eq('id', job.id)
      .eq('tenant_id', tenantId)
      .eq('source_file_path', 'pending')
      .select('id');
    if (error) throw new MobileUpstreamError('ocr_jobs.delete_stale');
    if ((data ?? []).length > 0) return { kind: 'fresh' };
  } else if (job.status === 'pending' && isStale(job)) {
    // Plik jest, a odczytu nikt nie zaczął: zdarzenie mogło nie wyjść. Job
    // odczytu jest idempotentny (jeden koszt na zadanie), więc drugie zdarzenie
    // przy żywym pierwszym niczego nie podwoi.
    await sendJobEvent(ocrProcessPhotoRequested.create({ ocrJobId: job.id, tenantId }));
  }

  const body: WgranieWydatkuOdpowiedz = { odczyt: { id: job.id }, powtorzenie: true };
  return { kind: 'job', response: mobileJson(body, 200, caller.headers) };
}

/** `POST /api/mobile/v1/wydatki/zdjecie`. */
export async function uploadExpenseFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const key = request.headers.get('idempotency-key')?.trim().toLowerCase() ?? '';
  if (!isUuid(key)) return mobileError(400, 'missing_idempotency_key', MISSING_KEY, headers);

  const head = checkUploadHeaders(request, { checkOrigin: false });
  if (!head.ok) return uploadRefusal(head, headers);

  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const userId = caller.user.id;
  const who = { tenantId, user: { id: userId } };

  const rate = await checkUploadRate('expense', who);
  if (!rate.ok) return uploadRefusal(rate, headers);

  const slot = reserveUploadBytes(head.contentLength, uploadCaller(who));
  if (!slot.ok) {
    await rate.refund();
    return uploadRefusal(slot, headers);
  }
  let refunded = false;
  const refund = async () => {
    if (refunded) return;
    refunded = true;
    await rate.refund();
  };

  try {
    const body = await readUploadForm(request, head.contentLength);
    if (!body.ok) {
      if (isServerSideRefusal(body)) await refund();
      return uploadRefusal(body, headers);
    }
    const file = body.form.get(MOBILE_EXPENSE_FILE_FIELD);
    if (!(file instanceof File)) return mobileError(400, 'file_invalid', NO_FILE, headers);
    const hash = sha256(await file.arrayBuffer());

    const earlier = await findKey(db, tenantId, userId, key);
    if (earlier) {
      // Ponowienie nie zużywa próby z limitu wgrań; wgranie od nowa (porzucone pierwsze) już tak.
      if (earlier.endpoint !== UPLOAD_ENDPOINT || earlier.request_hash !== hash || !earlier.ocr_job_id) {
        await refund();
        return mobileError(409, 'idempotency_conflict', KEY_CONFLICT, headers);
      }
      const again = await replay(caller, earlier.ocr_job_id);
      if (again.kind === 'job') {
        await refund();
        return again.response;
      }
    }

    let taken = false;
    let keyFailed = false;
    const result = await acceptExpenseDocument({
      userId,
      tenantId,
      file,
      onJobCreated: async (ocrJobId) => {
        const saved = await saveKey(db, tenantId, userId, key, hash, ocrJobId);
        if (saved === 'ok') return { ok: true };
        taken = saved === 'taken';
        keyFailed = saved === 'failed';
        return { ok: false, status: taken ? 409 : 503, error: taken ? KEY_CONFLICT : MOBILE_UNAVAILABLE };
      },
    });

    if (result.success) {
      const created: WgranieWydatkuOdpowiedz = { odczyt: { id: result.ocrJobId }, powtorzenie: false };
      return mobileJson(created, 201, headers);
    }

    // Równoległe wgranie z tym samym kluczem zdążyło pierwsze: oddajemy jego zadanie.
    if (taken) {
      await refund();
      const winner = await findKey(db, tenantId, userId, key);
      if (winner && winner.endpoint === UPLOAD_ENDPOINT && winner.request_hash === hash && winner.ocr_job_id) {
        const again = await replay(caller, winner.ocr_job_id);
        if (again.kind === 'job') return again.response;
      }
      return mobileError(409, 'idempotency_conflict', KEY_CONFLICT, headers);
    }

    if (result.status >= 500 || keyFailed) {
      // Magazyn, kolejka albo zapis klucza: wina serwera, próba wraca, telefon ponawia.
      await refund();
      return mobileError(503, 'service_unavailable', MOBILE_UNAVAILABLE, headers);
    }
    // Format albo rozmiar pliku z zawartości (AUD-105): ten sam komunikat co na stronie.
    return mobileError(result.status, 'file_invalid', result.error, headers);
  } finally {
    slot.release();
  }
}

/** `GET /api/mobile/v1/wydatki/odczyt/{id}`. */
export async function ocrStatusForMobile(caller: MobileCaller, ocrJobId: string): Promise<NextResponse> {
  const headers = caller.headers;
  const status = await readOcrJobStatus(dbOf(caller), ocrJobId.toLowerCase());
  if (!status.success) {
    // Stan nieznany: telefon pyta dalej, nie wgrywa zdjęcia drugi raz (E16).
    if (status.retryable) return mobileError(503, 'service_unavailable', MOBILE_UNAVAILABLE, { ...headers, 'Retry-After': '2' });
    return mobileError(404, 'not_found', NOT_FOUND_JOB, headers);
  }
  const { job } = status;
  const body: OdczytWydatkuOdpowiedz = {
    odczyt: {
      id: job.id,
      stan: job.status,
      wydatekId: job.status === 'completed' ? job.expense_id : null,
      blad: job.status === 'failed' ? (job.error_message ?? 'Nie udało się odczytać dokumentu.') : null,
    },
  };
  return mobileJson(body, 200, headers);
}

const REVIEW_STATUS: Record<Exclude<ExpenseReviewRefusal, 'not_found' | 'read_failed' | 'write_failed'>, number> = {
  invalid: 400,
  refused: 422,
  conflict: 409,
  ksef: 422,
};

/** `POST /api/mobile/v1/wydatki/{id}/zatwierdzenie`. */
export async function reviewExpenseFromMobile(caller: MobileCaller, expenseId: string, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(expenseId)) return mobileError(404, 'not_found', NOT_FOUND_EXPENSE, headers);
  const id = expenseId.toLowerCase();

  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    return mobileError(400, 'invalid_request', 'Treść żądania to JSON (Content-Type: application/json).', headers);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_REVIEW_BYTES) {
    return mobileError(400, 'invalid_request', 'Opis wydatku jest za długi. Skróć notatkę.', headers);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return mobileError(400, 'invalid_request', 'Treść żądania nie jest poprawnym JSON.', headers);
  }
  const parsed = zatwierdzenieWydatkuSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return mobileError(400, 'invalid_request', `Treść żądania nie pasuje do kontraktu (${sciezkaPola(issue?.path ?? []) ?? 'treść'}). Zaktualizuj aplikację FaktWay.`, headers);
  }

  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const result = await reviewExpense({ supabase: db, userId: caller.user.id, tenantId }, id, parsed.data.zmiany, { refuseKsef: true });
  if (!result.success) {
    if (result.reason === 'not_found') return mobileError(404, 'not_found', NOT_FOUND_EXPENSE, headers);
    if (result.reason === 'read_failed') throw new MobileUpstreamError('expenses.read');
    // Treść błędu bazy nie wychodzi do telefonu (strona pokazuje ją jak dotąd).
    if (result.reason === 'write_failed') return mobileError(503, 'service_unavailable', SAVE_FAILED, headers);
    const status = REVIEW_STATUS[result.reason];
    return mobileError(status, status === 400 ? 'invalid_request' : 'expense_invalid', result.error, headers);
  }

  const { data, error } = await db
    .from('expenses')
    .select('id, is_reviewed, is_deductible')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !data) throw new MobileUpstreamError('expenses.after_review');
  const body: ZatwierdzenieWydatkuOdpowiedz = {
    wydatek: { id: String(data.id), opisany: data.is_reviewed === true, wKpir: data.is_deductible === true },
  };
  return mobileJson(body, 200, headers);
}
