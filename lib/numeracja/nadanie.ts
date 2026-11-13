/**
 * Nadanie numeru faktury przy zapisie (plan kompletnej aplikacji, krok 2.5).
 *
 * Numer z licznika serii nadaje baza: wyzwalacz `zzz_invoice_number_assign`
 * (00199) w transakcji zapisu faktury, pod blokadą serii, przyjmuje tylko
 * kolejny wolny licznik i od razu go zapisuje. Aplikacja bierze kolejny numer
 * (`invoice_number_next`), buduje z nim fakturę (kolumna, fa3_data, koperta
 * zaliczki, korekty i rozliczenia, zlecenie wysyłki) i zapisuje. Gdy w tym
 * czasie inna faktura zajęła ten numer, baza odmawia (`invoice_number_moved`)
 * i aplikacja powtarza z następnym numerem. Dwa wystawienia naraz w jednej
 * serii dostają więc dwa różne kolejne numery.
 *
 * Numer z licznika idzie tylko wtedy, gdy w polu została podpowiedź z serii
 * (klient jej nie zmienił). Numer wpisany ręcznie zapisuje się jak dotąd,
 * z serią i bez licznika; zajęty numer dostaje dotychczasowy komunikat.
 *
 * Ponowienie: klucz zapisu (`number_request_key`) jest jeden na otwarcie
 * formularza. Drugi zapis z tym kluczem (podwójne kliknięcie, ponowienie po
 * zerwanym połączeniu) nie tworzy drugiej faktury: baza odmawia, a klient
 * dostaje numer pierwszej. Bez tego klucza ponowienie z następnym numerem
 * wystawiłoby drugą fakturę (indeks numeru już tego nie łapie).
 *
 * W pliku nie ma zapisu faktury: zapisuje wołający (akcja formularza).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type NumberConflict = 'moved' | 'number_taken' | 'request_done';

interface DbError {
  code?: string | null;
  message?: string | null;
}

/** Rodzaj konfliktu numeru z błędu zapisu faktury; `null`, gdy to inny błąd. */
export function numberConflictOf(error: DbError | null | undefined): NumberConflict | null {
  if (!error) return null;
  const message = error.message ?? '';
  if (error.code === 'P0001') {
    if (message === 'invoice_number_moved') return 'moved';
    if (message === 'invoice_number_request_done') return 'request_done';
    return null;
  }
  if (error.code === '23505') {
    if (message.includes('uq_invoices_number_request_key')) return 'request_done';
    if (message.includes('uq_invoices_tenant_outgoing_internal_number')) return 'number_taken';
    // Ten sam licznik w serii (druga ochrona za blokadą): kolejny numer.
    if (message.includes('uq_invoices_number_series_counter')) return 'moved';
  }
  return null;
}

const SERIES_REFUSALS: Record<string, string> = {
  invoice_number_series_not_found:
    'Nie znaleziono wybranej serii numeracji. Odśwież stronę i wybierz serię ponownie albo wpisz numer ręcznie.',
  invoice_number_series_archived:
    'Wybrana seria numeracji jest ukryta. Wybierz inną serię albo przywróć ją w Ustawieniach, w sekcji Numeracja faktur.',
  invoice_number_series_no_pattern:
    'Ta seria nie ma wzoru numeru. Wpisz numer faktury ręcznie albo wybierz serię ze wzorem.',
  invoice_number_mismatch:
    'Numer nie zgadza się z serią i datą wystawienia. Odśwież stronę i zapisz fakturę ponownie.',
  invoice_number_exhausted:
    'W tej serii kolejne numery są zajęte przez inne faktury. Wpisz numer ręcznie albo wybierz inną serię.',
  invoice_number_series_outgoing_only: 'Seria numeracji dotyczy tylko faktur sprzedaży.',
  invoice_number_foreign_tenant:
    'Ta faktura należy do innej firmy niż aktywna. Odśwież stronę i wystaw fakturę w aktywnej firmie.',
};

/** Polski komunikat dla odmowy wyzwalacza numeracji (00199); `null`, gdy to inny błąd. */
export function numberRefusalText(error: DbError | null | undefined): string | null {
  if (!error?.message) return null;
  return SERIES_REFUSALS[error.message] ?? null;
}

const NEXT_REFUSALS: Record<string, string> = {
  not_found: SERIES_REFUSALS.invoice_number_series_not_found!,
  archived: SERIES_REFUSALS.invoice_number_series_archived!,
  exhausted: SERIES_REFUSALS.invoice_number_exhausted!,
};

export const NUMBER_UNAVAILABLE_MESSAGE =
  'Nie udało się pobrać kolejnego numeru z serii. Spróbuj ponownie za chwilę albo wpisz numer ręcznie.';

export const NUMBER_RACE_MESSAGE =
  'Nie udało się nadać kolejnego numeru z serii, bo w tym czasie inne faktury zajmowały kolejne numery. Spróbuj ponownie za chwilę.';

/** Tyle razy bierzemy następny numer, gdy poprzedni zajęła inna faktura. */
const MAX_ATTEMPTS = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrUndefined(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

/** Kolumny numeracji w wierszu faktury (00199); puste dla numeracji sprzed serii. */
export interface NumberColumns {
  number_series_id?: string;
  number_period?: string;
  number_counter?: number;
  number_request_key?: string;
}

export interface AssignedNumber {
  number: string;
  columns: NumberColumns;
  /** Numer z licznika serii (nie z pola). */
  fromSeries: boolean;
}

export interface NumberRequest {
  /** Numer z pola formularza. */
  typed: string;
  seriesId?: string | null;
  /** Podpowiedź z licznika, którą formularz wpisał w pole. */
  preview?: string | null;
  /** Jeden na otwarcie formularza. */
  requestKey?: string | null;
}

/** Pola numeracji z formularza (wszystkie rodzaje faktur). */
export interface NumberingFormFields {
  internalNumber: string;
  numberSeriesId?: string | null;
  numberPreview?: string | null;
  numberRequestKey?: string | null;
}

export function numberRequestOf(values: NumberingFormFields): NumberRequest {
  return {
    typed: values.internalNumber,
    seriesId: values.numberSeriesId ?? null,
    preview: values.numberPreview ?? null,
    requestKey: values.numberRequestKey ?? null,
  };
}

type Refusal = { success: false; error: string; invoiceId?: string };

/** Wynik zapisu z ewentualnym konfliktem numeru (tylko między tym modułem a akcją). */
export type NumberedResult<R> = R | { success: false; error: string; invoiceId?: string; numberConflict: NumberConflict };

export type NextNumber =
  | { ok: true; number: string; counter: number; period: string }
  | { ok: false; code: string };

/** Kolejny wolny numer serii na dzień wystawienia (RPC 00199, firma z sesji). */
export async function nextSeriesNumber(db: SupabaseClient, seriesId: string, issueDate: string): Promise<NextNumber> {
  try {
    const { data, error } = await db.rpc('invoice_number_next', { p_series_id: seriesId, p_issue_date: issueDate });
    if (error || !data || typeof data !== 'object') return { ok: false, code: 'unavailable' };
    const out = data as Record<string, unknown>;
    if (out.status === 'ok' && typeof out.number === 'string' && typeof out.counter === 'number' && typeof out.period === 'string') {
      return { ok: true, number: out.number, counter: out.counter, period: out.period };
    }
    return { ok: false, code: typeof out.code === 'string' ? out.code : 'unavailable' };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}

/** Faktura zapisana już z tym kluczem: jej numer w komunikacie i identyfikator do przejścia. */
async function alreadySaved(db: SupabaseClient, requestKey: string | undefined): Promise<Refusal> {
  if (requestKey) {
    const { data } = await db
      .from('invoices')
      .select('id, internal_number')
      .eq('number_request_key', requestKey)
      .maybeSingle();
    const row = data as { id?: unknown; internal_number?: unknown } | null;
    if (row && typeof row.id === 'string') {
      const number = typeof row.internal_number === 'string' && row.internal_number ? row.internal_number : 'bez numeru';
      return {
        success: false,
        error: `Ta faktura jest już zapisana pod numerem ${number}. Otwórz ją z listy faktur zamiast zapisywać drugi raz.`,
        invoiceId: row.id,
      };
    }
  }
  return { success: false, error: 'Ta faktura jest już zapisana. Sprawdź listę faktur zamiast zapisywać drugi raz.' };
}

function conflictOf<R extends { success: boolean }>(result: NumberedResult<R>): NumberConflict | null {
  if (result.success) return null;
  const conflict = (result as { numberConflict?: unknown }).numberConflict;
  return conflict === 'moved' || conflict === 'number_taken' || conflict === 'request_done' ? conflict : null;
}

/** Wynik dla klienta bez wewnętrznego kodu konfliktu. */
function forClient<R extends { success: boolean }>(result: NumberedResult<R>): R | Refusal {
  if (result.success) return result as R;
  const failure = result as { error: string; invoiceId?: string };
  return { success: false, error: failure.error, ...(failure.invoiceId ? { invoiceId: failure.invoiceId } : {}) };
}

/**
 * Zapis faktury z numerem: z licznika serii (podpowiedź nietknięta) albo
 * z pola. `save` buduje fakturę z podanym numerem, zapisuje ją z podanymi
 * kolumnami i zwraca wynik z `numberConflict`, gdy baza odmówiła numeru.
 * `built` to faktura, która się zapisała (do zlecenia wysyłki).
 */
export async function saveWithInvoiceNumber<R extends { success: boolean }, B>(
  db: SupabaseClient,
  request: NumberRequest,
  issueDate: string,
  save: (assigned: AssignedNumber) => Promise<{ result: NumberedResult<R>; built: B }>,
): Promise<{ result: R | Refusal; built: B | null }> {
  const requestKey = uuidOrUndefined(request.requestKey);
  const seriesId = uuidOrUndefined(request.seriesId);
  const keyColumn: NumberColumns = requestKey ? { number_request_key: requestKey } : {};
  const typed = request.typed.trim();
  const preview = request.preview?.trim() ?? '';
  let typedColumns: NumberColumns = { ...(seriesId ? { number_series_id: seriesId } : {}), ...keyColumn };

  if (seriesId && preview !== '' && typed === preview) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const next = await nextSeriesNumber(db, seriesId, issueDate);
      if (!next.ok) {
        // Seria bez wzoru (numeracja jak dotąd): numer z pola, z serią.
        if (next.code === 'no_pattern') break;
        return { result: { success: false, error: NEXT_REFUSALS[next.code] ?? NUMBER_UNAVAILABLE_MESSAGE }, built: null };
      }
      const outcome = await save({
        number: next.number,
        columns: { number_series_id: seriesId, number_period: next.period, number_counter: next.counter, ...keyColumn },
        fromSeries: true,
      });
      const conflict = conflictOf(outcome.result);
      if (!conflict) return { result: forClient(outcome.result), built: outcome.result.success ? outcome.built : null };
      if (conflict === 'request_done') return { result: await alreadySaved(db, requestKey), built: null };
      // moved, number_taken: numer zajęty w międzyczasie, bierzemy następny.
      if (attempt === MAX_ATTEMPTS) return { result: { success: false, error: NUMBER_RACE_MESSAGE }, built: null };
    }
    typedColumns = { number_series_id: seriesId, ...keyColumn };
  }

  const outcome = await save({ number: request.typed, columns: typedColumns, fromSeries: false });
  if (conflictOf(outcome.result) === 'request_done' && requestKey) {
    return { result: await alreadySaved(db, requestKey), built: null };
  }
  return { result: forClient(outcome.result), built: outcome.result.success ? outcome.built : null };
}
