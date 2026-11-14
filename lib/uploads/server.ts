import 'server-only';

import { NextResponse } from 'next/server';

import { isMaintenanceMode } from '@/lib/feature-flags/maintenance';
import { checkRateLimit } from '@/lib/rate-limit';
import { ActionAuthError, requireUserAndActiveOrg, type AuthContext } from '@/lib/supabase/auth-context';
import { formatUploadSize, UPLOAD_BODY_LIMIT_BYTES, UPLOAD_FILE_LIMIT_LABEL } from '@/lib/upload-limit';

/**
 * Bramka tras wgrywania plików (plan skalowania, sesja 31; LIM-08, HOR-V1,
 * CPU-06): `/api/uploads/expense`, `/api/uploads/import`, `/share-target`
 * i `/api/uploads/logo` (logo firmy, plan kompletnej aplikacji, krok 2.2).
 *
 * PO CO. Trasy są POZA proxy (`proxy.ts`, matcher): proxy Next czyta całe
 * ciało żądania z gniazda i trzyma w pamięci jego kopię do 10 MiB, zanim
 * trasa ruszy, a nadmiar ucina po cichu. Bez proxy trasa sama decyduje, kiedy
 * czytać ciało — i musi sama zrobić to, co proxy robi dla `/api/*`:
 *
 * | Krok | Funkcja | Odmowa |
 * |---|---|---|
 * | multipart, Origin tej strony, `Content-Length` w limicie — bez czytania ciała | `checkUploadHeaders` | 415, 403, 411, 413 |
 * | sesja, 2FA, członkostwo w aktywnej firmie, przerwa techniczna | `authorizeUpload` | 401, 403, 503 |
 * | limit wgrań na osobę w firmie | `checkUploadRate` | 429 |
 * | najwyżej 2 wgrania naraz na osobę w firmie i budżet bajtów w procesie (pamięć jedynego procesu web, dzielonego z workerem na app-1) | `reserveUploadBytes` | 429, 503 |
 * | odczyt ciała: dokładnie `Content-Length` bajtów (bez nagłówka — najwyżej limit ciała), w 120 s, potem multipart | `readUploadForm` | 400, 408, 413 |
 *
 * Odmowa z winy serwera (zajęty budżet, zerwany odczyt, błąd magazynu albo
 * kolejki) oddaje próbę z limitu wgrań (`refund`), bo klient ponawia.
 *
 * Każda odmowa ma polski komunikat (`error`) — okno wgrywania pokazuje go
 * w toaście, `/share-target` zamienia ją na komunikat na Kosztach.
 */

export type UploadKind = 'expense' | 'import' | 'logo';

export type UploadRefusalReason =
  | 'bad_type'
  | 'cross_origin'
  | 'length_required'
  | 'too_large'
  | 'unauthenticated'
  | 'forbidden'
  | 'auth_unavailable'
  | 'maintenance'
  | 'rate_limited'
  | 'busy'
  | 'timeout'
  | 'bad_body';

export interface UploadRefusal {
  ok: false;
  status: number;
  reason: UploadRefusalReason;
  /** Komunikat dla klienta, po polsku. */
  error: string;
  /** Sekundy do ponownej próby (429, 503). */
  retryAfter?: number;
  /** Rozmiar w bajtach przy `too_large`. */
  size?: number;
}

/** Limit wgrań na osobę w firmie: okno 10 minut. */
export const UPLOAD_RATE_WINDOW_SECONDS = 600;

/**
 * Ile wgrań na osobę w firmie w oknie. Koszt to zwykle kilka zdjęć z rzędu
 * (rozliczenie miesiąca), import to kilka plików (np. kwartały), logo firmy
 * (krok 2.2) to kilka prób wyboru pliku. Limit łapie pętlę albo skrypt,
 * a nie człowieka; odczyty OCR ma osobno budżet AI firmy
 * (`lib/ai/tenant-ai-budget.ts`).
 */
export const UPLOAD_RATE_LIMITS: Record<UploadKind, number> = { expense: 30, import: 10, logo: 10 };

/**
 * Budżet bajtów wgrań naraz w procesie web: cztery największe pliki albo
 * kilkadziesiąt zdjęć. Plik siedzi w pamięci ok. 3 razy (multipart, `File`,
 * bufor do magazynu), więc to ok. 120 MB w najgorszym razie. Na wzór
 * `batch-pdf` (AUD-119): proces dzieli app-1 z workerem. Przy replikach
 * (etap 2) każda liczy swój budżet.
 */
export const UPLOAD_BYTES_IN_FLIGHT_LIMIT = 4 * UPLOAD_BODY_LIMIT_BYTES;

/**
 * Wgrania naraz jednej osoby w jednej firmie (wszystkie trasy razem). Okno
 * wysyła jeden plik naraz, więc 2 to zapas na udostępnienie z telefonu w tym
 * samym czasie. Bez tego jedno konto z czterema wolnymi wgraniami zajęłoby
 * cały budżet procesu i wszystkie firmy dostawałyby „serwer zajęty”.
 */
export const UPLOADS_IN_FLIGHT_PER_CALLER = 2;

/**
 * Najdłuższy odczyt ciała. Plik 10 MB przy 1 Mbit/s wysyła się ok. 80 s;
 * dłużej trzymane miejsce w budżecie to już wolne albo zawieszone połączenie
 * (serwer Node sam ucina żądanie dopiero po 300 s). Odczyt staje, budżet
 * wraca, klient dostaje 408 z komunikatem.
 */
export const UPLOAD_READ_TIMEOUT_MS = 120_000;

const BUSY_RETRY_AFTER_SECONDS = 5;

let bytesInFlight = 0;
const inFlightByCaller = new Map<string, number>();

function refuse(status: number, reason: UploadRefusalReason, error: string, extra: Partial<UploadRefusal> = {}): UploadRefusal {
  return { ok: false, status, reason, error, ...extra };
}

const RETRY_MESSAGE = 'Odśwież stronę i spróbuj ponownie.';

/** Host, pod którym przeglądarka widzi aplikację (jak w Server Actions: `x-forwarded-host`, potem `host`). */
function requestHost(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwarded || headers.get('host')?.trim();
  return host ? host.toLowerCase() : null;
}

/**
 * Żądanie z tej samej strony. Brak `Origin` przepuszczamy jak Next w Server
 * Actions: przeglądarka wysyła go przy każdym POST z `fetch` i formularza,
 * więc brak znaczy klienta spoza przeglądarki, który ciasteczek sesji nie
 * dostał od innej strony. `Origin: null` (piaskownica, plik lokalny) — odmowa.
 * Ciasteczka sesji mają `SameSite=Lax`, więc to druga warstwa, nie jedyna.
 */
function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin');
  if (origin === null) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (!originHost) return false;
  return originHost === requestHost(headers);
}

/**
 * Nagłówki, zanim ktokolwiek dotknie ciała i zanim zawołamy GoTrue.
 * Przy `Content-Length` ponad limit — odmowa bez czytania ciała. Przeglądarka
 * wysyła ten nagłówek przy `FormData`, a serwer HTTP Node nie odda trasie
 * więcej bajtów, niż on mówi. Bez nagłówka (ciało porcjami, np. gdy odwrotne
 * proxy przekazuje tak żądanie HTTP/2 bez długości) `contentLength` to `null`
 * i `readUploadForm` czyta najwyżej limit ciała, potem przerywa — odmowa
 * z góry mogłaby wyłączyć wgrywanie wszystkim za takim proxy.
 */
export function checkUploadHeaders(
  req: Request,
  options: { checkOrigin: boolean },
): UploadRefusal | { ok: true; contentLength: number | null } {
  const type = req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;.*boundary=/i.test(type)) {
    return refuse(415, 'bad_type', `Nieprawidłowe żądanie wgrania pliku. ${RETRY_MESSAGE}`);
  }
  if (options.checkOrigin && !isSameOrigin(req.headers)) {
    return refuse(403, 'cross_origin', `Plik można wgrać tylko z FaktWay. ${RETRY_MESSAGE}`);
  }
  const raw = req.headers.get('content-length');
  if (raw === null) return { ok: true, contentLength: null };
  if (!/^\d{1,15}$/.test(raw)) {
    return refuse(411, 'length_required', `Nie udało się wysłać pliku. ${RETRY_MESSAGE}`);
  }
  const contentLength = Number(raw);
  if (contentLength > UPLOAD_BODY_LIMIT_BYTES) {
    return refuse(
      413,
      'too_large',
      `Plik ma ${formatUploadSize(contentLength)}, a można wgrać najwyżej ${UPLOAD_FILE_LIMIT_LABEL}.`,
      { size: contentLength },
    );
  }
  return { ok: true, contentLength };
}

function waitMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Spróbuj ponownie za ${minutes} min.`;
}

/**
 * Sesja, 2FA i aktywna firma (`requireUserAndActiveOrg`, ta sama granica co
 * dawne akcje) oraz przerwa techniczna (jak proxy dla `/api/*`; `/share-target`
 * proxy jej nie sprawdzało, więc i tu bez niej).
 */
export async function authorizeUpload(options: { maintenanceGate: boolean }): Promise<UploadRefusal | { ok: true; ctx: AuthContext }> {
  let ctx: AuthContext;
  try {
    ctx = await requireUserAndActiveOrg();
  } catch (error) {
    if (!(error instanceof ActionAuthError)) throw error;
    if (error.message === 'Niezalogowany') {
      return refuse(401, 'unauthenticated', 'Sesja wygasła. Zaloguj się ponownie i wgraj plik jeszcze raz.');
    }
    if (error.message.startsWith('Nie udało się zweryfikować sesji')) {
      return refuse(503, 'auth_unavailable', error.message);
    }
    return refuse(403, 'forbidden', error.message);
  }

  if (options.maintenanceGate && (await isMaintenanceMode())) {
    return refuse(503, 'maintenance', 'Trwa przerwa techniczna. Spróbuj wgrać plik za kilka minut.', { retryAfter: 60 });
  }
  return { ok: true, ctx };
}

/**
 * Limit wgrań na osobę w firmie, po sprawdzeniu nagłówków (plik odrzucony
 * po rozmiarze nie zużywa próby). Bez Redisa limit liczy pamięć procesu
 * (`checkRateLimit`), nie blokuje wgrań. Odmowa nie wydłuża blokady
 * (`countDenied: false`). `refund` oddaje próbę, gdy wgranie nie powiodło się
 * z winy serwera (zajęty budżet, błąd magazynu albo kolejki) — wtedy klient
 * ponawia, a ponowienie nie może go zablokować.
 */
export async function checkUploadRate(
  kind: UploadKind,
  ctx: Pick<AuthContext, 'tenantId' | 'user'>,
): Promise<UploadRefusal | { ok: true; refund: () => Promise<void> }> {
  const quota = await checkRateLimit({
    bucket: 'file_upload',
    identifier: `${kind}:${ctx.tenantId}:${ctx.user.id}`,
    limit: UPLOAD_RATE_LIMITS[kind],
    windowSeconds: UPLOAD_RATE_WINDOW_SECONDS,
    countDenied: false,
  });
  if (!quota.allowed) {
    const retryAfter = Math.max(1, quota.retryAfter);
    return refuse(
      429,
      'rate_limited',
      `Wgrano już dużo plików w krótkim czasie. ${waitMessage(retryAfter)}`,
      { retryAfter },
    );
  }
  return { ok: true, refund: quota.refund ?? (async () => {}) };
}

/**
 * Odmowa, za którą klient nie odpowiada (zajęty serwer, zerwany albo zbyt
 * wolny odczyt) — trasa oddaje wtedy próbę z limitu wgrań.
 */
export function isServerSideRefusal(refusal: UploadRefusal): boolean {
  return refusal.reason === 'busy' || refusal.reason === 'timeout' || refusal.reason === 'bad_body';
}

/** Klucz osoby w firmie do limitu wgrań naraz. */
export function uploadCaller(ctx: Pick<AuthContext, 'tenantId' | 'user'>): string {
  return `${ctx.tenantId}:${ctx.user.id}`;
}

/**
 * Rezerwuje miejsce na jedno wgranie: `bytes` z budżetu procesu (`null` =
 * ciało bez `Content-Length`, czyli najgorszy przypadek: pełny limit ciała)
 * i jedno z `UPLOADS_IN_FLIGHT_PER_CALLER` miejsc osoby w firmie. Zwraca
 * `release` (można wołać wiele razy) albo odmowę. Sprawdzenie i zajęcie bez
 * `await` pomiędzy — równoległe żądania nie przejdą razem.
 */
export function reserveUploadBytes(
  requested: number | null,
  caller: string,
): UploadRefusal | { ok: true; release: () => void } {
  const bytes = requested ?? UPLOAD_BODY_LIMIT_BYTES;
  const mine = inFlightByCaller.get(caller) ?? 0;
  if (mine >= UPLOADS_IN_FLIGHT_PER_CALLER) {
    return refuse(
      429,
      'busy',
      'Poprzednie pliki jeszcze się wysyłają. Poczekaj, aż się skończą, i spróbuj ponownie.',
      { retryAfter: BUSY_RETRY_AFTER_SECONDS },
    );
  }
  if (bytes < 0 || bytesInFlight + bytes > UPLOAD_BYTES_IN_FLIGHT_LIMIT) {
    return refuse(
      503,
      'busy',
      'Serwer przyjmuje teraz kilka dużych plików naraz. Spróbuj ponownie za kilka sekund.',
      { retryAfter: BUSY_RETRY_AFTER_SECONDS },
    );
  }
  bytesInFlight += bytes;
  inFlightByCaller.set(caller, mine + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      bytesInFlight -= bytes;
      const left = (inFlightByCaller.get(caller) ?? 1) - 1;
      if (left > 0) inFlightByCaller.set(caller, left);
      else inFlightByCaller.delete(caller);
    },
  };
}

/**
 * Czyta ciało i parsuje multipart. Przy `Content-Length` bajtów musi być
 * dokładnie tyle, ile mówi nagłówek: krótsze ciało to zerwane połączenie,
 * dłuższe — fałszywy nagłówek (serwer Node do tego nie dopuszcza, test tak).
 * Bez nagłówka czytamy najwyżej limit ciała: przy pierwszym bajcie ponad
 * limit odczyt staje (413). Po `timeoutMs` odczyt też staje (408), żeby wolne
 * albo zawieszone połączenie nie trzymało miejsca w budżecie. Licznik nie
 * robi kopii pliku, tylko przepuszcza kawałki do parsera.
 */
export async function readUploadForm(
  req: Request,
  contentLength: number | null,
  options: { timeoutMs?: number } = {},
): Promise<UploadRefusal | { ok: true; form: FormData }> {
  const broken = refuse(400, 'bad_body', 'Nie udało się odebrać całego pliku. Sprawdź połączenie i spróbuj ponownie.');
  if (!req.body) return broken;

  const cap = contentLength ?? UPLOAD_BODY_LIMIT_BYTES;
  let total = 0;
  let overLimit = false;
  let timedOut = false;
  let counterController: TransformStreamDefaultController<Uint8Array> | null = null;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      counterController = controller;
    },
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > cap) {
        overLimit = contentLength === null;
        controller.error(new Error(overLimit ? 'ciało ponad limit' : 'ciało dłuższe niż Content-Length'));
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (contentLength !== null && total !== contentLength) controller.error(new Error('ciało krótsze niż Content-Length'));
    },
  });

  // Błąd strumienia-licznika odrzuca parser i przerywa odczyt źródła (pipeThrough).
  const timer = setTimeout(() => {
    timedOut = true;
    counterController?.error(new Error('odczyt ciała trwa za długo'));
  }, options.timeoutMs ?? UPLOAD_READ_TIMEOUT_MS);

  try {
    const form = await new Response(req.body.pipeThrough(counter), {
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
    }).formData();
    return { ok: true, form };
  } catch {
    if (overLimit) {
      return refuse(413, 'too_large', `Plik przekracza ${UPLOAD_FILE_LIMIT_LABEL}: tyle można wgrać najwyżej.`);
    }
    if (timedOut) {
      return refuse(408, 'timeout', 'Wysyłanie pliku trwało za długo. Sprawdź połączenie i spróbuj ponownie.');
    }
    return broken;
  } finally {
    clearTimeout(timer);
  }
}

/** Odpowiedź JSON trasy wgrywania: nigdy z cache, z `Retry-After` przy odmowie czasowej. */
export function uploadJson(
  body: { success: true; [key: string]: unknown } | { success: false; error: string },
  status: number,
  retryAfter?: number,
): NextResponse {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (retryAfter !== undefined) headers['Retry-After'] = String(retryAfter);
  return NextResponse.json(body, { status, headers });
}

/** Odmowa bramki jako odpowiedź JSON. */
export function refusalJson(refusal: UploadRefusal): NextResponse {
  return uploadJson({ success: false, error: refusal.error }, refusal.status, refusal.retryAfter);
}

/** Ślad odmowy w logu procesu (bez danych klienta) — do pomiaru po wdrożeniu. */
export function logUploadRefusal(route: string, refusal: UploadRefusal): void {
  console.warn(`[uploads] ${route}: ${refusal.reason} (${refusal.status})${refusal.size ? ` ${refusal.size} B` : ''}`);
}
