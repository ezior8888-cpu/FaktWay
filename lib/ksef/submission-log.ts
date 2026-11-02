/**
 * Historia prób wysyłki do KSeF (`ksef_submissions`, kolumny z 00099).
 *
 * Po co: KSeF po przyjęciu pliku nadaje numer sesji i numer referencyjny
 * faktury, zanim przydzieli numer KSeF. Zapisane od razu pozwalają:
 *   - po niepewnym wyniku (timeout pollingu, 5xx, padnięty worker) zapytać
 *     KSeF o status tej samej wysyłki zamiast wysyłać fakturę drugi raz,
 *   - rozpoznać, że odpowiedź 440 „duplikat” dotyczy naszej wcześniejszej
 *     wysyłki (ten sam numer sesji), a nie cudzej faktury o tym numerze,
 *   - pobrać UPO, które w KSeF 2.0 leży wyłącznie w zasobach sesji.
 *
 * Zamiar (A2, 00136): wpis `intent` z numerem sesji powstaje po otwarciu
 * sesji, PRZED wysłaniem pliku. Gdy odpowiedź na wysyłkę zginie (timeout,
 * padnięty worker, błąd zapisu), ponowienie wie, o którą sesję zapytać KSeF,
 * zamiast wysyłać fakturę drugi raz. Statusy wpisu:
 *   intent → sent (KSeF przyjął plik, znamy numer referencyjny faktury)
 *          → abandoned (pliku w tej sesji nie ma — wysyłka może iść od nowa)
 *   sent   → accepted | rejected | duplicate | number_taken
 * `intent` i `sent` są dowodem kontaktu z KSeF (00131/00136), `abandoned` nie.
 * `number_taken` (D-A4-1, 00142): KSeF odrzucił plik jako duplikat, a oryginał
 * pochodzi z innego programu (treść sprawdzona) — nie jest dowodem kontaktu.
 *
 * Tylko service_role (00027) — wywołania wyłącznie z jobów.
 */

import { createAdminClient } from '@/lib/supabase/admin';

import {
  DUPLICATE_ORIGINAL_OFFERS,
  mergeDuplicateCheck,
  parseDuplicateCheck,
  type DuplicateDecisionChoice,
  type DuplicateOriginalOffer,
  type KsefDuplicateCheck,
} from './duplicate-check';

export interface KsefSubmissionReferences {
  sessionReferenceNumber: string;
  invoiceReferenceNumber: string;
  /** Klucz XML tej próby w magazynie (D5, kolumna z 00134); `null` dla wpisów sprzed zmiany. */
  xmlStoragePath?: string | null;
  /** Kiedy plik dotarł do KSeF — po 48 h bez odpowiedzi KSeF wpis uznajemy za zalegający (I5). */
  attemptedAt?: string | null;
  /** SHA-256 hex pliku tej próby. */
  payloadHash?: string | null;
  /**
   * D-A4-1 (00142): KSeF odpowiedział na tę próbę 440, a werdykt czeka —
   * numer KSeF i sesja oryginału. Uzgodnienie idzie wtedy prosto do
   * weryfikacji treści (nie pyta o status starej sesji, nie zamyka jako STALE).
   */
  originalKsefNumber?: string | null;
  originalSessionReferenceNumber?: string | null;
}

type SubmissionStatus = 'intent' | 'sent' | 'accepted' | 'rejected' | 'duplicate' | 'abandoned' | 'number_taken';

/** Zamiar wysyłki bez numeru referencyjnego faktury — do rozstrzygnięcia w KSeF. */
export interface KsefSubmissionIntent {
  sessionReferenceNumber: string;
  /** SHA-256 hex pliku tej próby (jak `xml_documents.sha256_hash`). */
  payloadHash: string | null;
  xmlStoragePath: string | null;
  attemptedAt: string | null;
}

/**
 * Zamiar wysyłki: sesja otwarta, plik jeszcze nie wysłany (A2). Rzuca przy
 * błędzie bazy — wtedy plik NIE może wyjść do KSeF.
 */
export async function recordKsefSubmissionIntent(params: {
  tenantId: string;
  invoiceId: string;
  sessionReferenceNumber: string;
  payloadHash?: string | null;
  xmlStoragePath?: string | null;
}): Promise<void> {
  const { error } = await createAdminClient()
    .from('ksef_submissions')
    .insert({
      tenant_id: params.tenantId,
      invoice_id: params.invoiceId,
      submission_type: 'online',
      status: 'intent' satisfies SubmissionStatus,
      session_reference_number: params.sessionReferenceNumber,
      invoice_reference_number: null,
      request_payload_hash: params.payloadHash ?? null,
      xml_storage_path: params.xmlStoragePath ?? null,
    });
  if (error) throw new Error('Nie można zapisać zamiaru wysyłki KSeF — faktura nie została wysłana');
}

/**
 * Zamiar tej sesji → `sent` z numerem referencyjnym faktury. Zwraca, czy był
 * zamiar do awansu (wpisy sprzed 00136 go nie mają). Rzuca przy błędzie bazy.
 */
export async function promoteKsefSubmissionIntent(params: {
  tenantId: string;
  invoiceId: string;
  sessionReferenceNumber: string;
  invoiceReferenceNumber: string;
}): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from('ksef_submissions')
    .update({
      status: 'sent' satisfies SubmissionStatus,
      invoice_reference_number: params.invoiceReferenceNumber,
    })
    .eq('tenant_id', params.tenantId)
    .eq('invoice_id', params.invoiceId)
    .eq('session_reference_number', params.sessionReferenceNumber)
    .eq('status', 'intent')
    .select('id');
  if (error) throw new Error('Nie można zapisać numerów referencyjnych wysyłki KSeF');
  return Array.isArray(data) && data.length > 0;
}

/**
 * Zamiar tej sesji → `abandoned`: KSeF nie ma pliku z tej próby (pusta sesja
 * albo odmowa przyjęcia pliku). Przestaje być dowodem kontaktu. Rzuca przy
 * błędzie bazy.
 */
export async function abandonKsefSubmissionIntent(params: {
  tenantId: string;
  invoiceId: string;
  sessionReferenceNumber: string;
  errorCode: string;
  errorMessage: string;
}): Promise<void> {
  const { error } = await createAdminClient()
    .from('ksef_submissions')
    .update({
      status: 'abandoned' satisfies SubmissionStatus,
      error_code: params.errorCode.slice(0, 20),
      error_message: params.errorMessage.slice(0, 500),
      completed_at: new Date().toISOString(),
    })
    .eq('tenant_id', params.tenantId)
    .eq('invoice_id', params.invoiceId)
    .eq('session_reference_number', params.sessionReferenceNumber)
    .eq('status', 'intent');
  if (error) throw new Error('Nie można zamknąć zamiaru wysyłki KSeF');
}

/**
 * Zamiary tej faktury bez rozstrzygnięcia, od najstarszego. Rzuca przy błędzie
 * bazy — bez tej wiedzy nie wolno wysyłać ponownie.
 */
export async function findOpenKsefSubmissionIntents(
  tenantId: string,
  invoiceId: string,
): Promise<KsefSubmissionIntent[]> {
  const { data, error } = await createAdminClient()
    .from('ksef_submissions')
    .select('session_reference_number, request_payload_hash, xml_storage_path, attempted_at')
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId)
    .eq('status', 'intent')
    .not('session_reference_number', 'is', null)
    .order('attempted_at', { ascending: true });
  if (error) throw new Error('Nie można odczytać historii wysyłki KSeF');
  return (data ?? []).map((r) => ({
    sessionReferenceNumber: r.session_reference_number as string,
    payloadHash: r.request_payload_hash ?? null,
    xmlStoragePath: r.xml_storage_path ?? null,
    attemptedAt: r.attempted_at ?? null,
  }));
}

/**
 * Zapis zaraz po przyjęciu pliku przez KSeF: zamiar tej sesji staje się
 * wpisem `sent`; bez zamiaru (wywołanie sprzed 00136) — nowy wpis. Rzuca przy
 * błędzie bazy — wywołujący decyduje, czy kontynuować (wysyłka już się odbyła).
 */
export async function recordKsefSubmissionSent(params: {
  tenantId: string;
  invoiceId: string;
  references: KsefSubmissionReferences;
  payloadHash?: string | null;
  /** Klucz XML, który poszedł do KSeF w tej próbie (D5). */
  xmlStoragePath?: string | null;
}): Promise<void> {
  const promoted = await promoteKsefSubmissionIntent({
    tenantId: params.tenantId,
    invoiceId: params.invoiceId,
    sessionReferenceNumber: params.references.sessionReferenceNumber,
    invoiceReferenceNumber: params.references.invoiceReferenceNumber,
  });
  if (promoted) return;
  const { error } = await createAdminClient()
    .from('ksef_submissions')
    .insert({
      tenant_id: params.tenantId,
      invoice_id: params.invoiceId,
      submission_type: 'online',
      status: 'sent' satisfies SubmissionStatus,
      session_reference_number: params.references.sessionReferenceNumber,
      invoice_reference_number: params.references.invoiceReferenceNumber,
      request_payload_hash: params.payloadHash ?? null,
      xml_storage_path: params.xmlStoragePath ?? null,
    });
  if (error) throw new Error('Nie można zapisać numerów referencyjnych wysyłki KSeF');
}

/** Zamknięcie wpisu po rozstrzygnięciu (akceptacja, odrzucenie). */
export async function markKsefSubmission(params: {
  tenantId: string;
  invoiceId: string;
  invoiceReferenceNumber: string;
  status: SubmissionStatus;
  ksefNumber?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  const { error } = await createAdminClient()
    .from('ksef_submissions')
    .update({
      status: params.status,
      response_ksef_number: params.ksefNumber ?? null,
      error_code: params.errorCode ?? null,
      error_message: params.errorMessage ? params.errorMessage.slice(0, 500) : null,
      completed_at: new Date().toISOString(),
    })
    .eq('tenant_id', params.tenantId)
    .eq('invoice_id', params.invoiceId)
    .eq('invoice_reference_number', params.invoiceReferenceNumber);
  if (error) throw new Error('Nie można zamknąć wpisu historii wysyłki KSeF');
}

/**
 * Ostatnia wysyłka tej faktury, która dotarła do KSeF i nie ma jeszcze
 * rozstrzygnięcia. Rzuca przy błędzie bazy — bez tej wiedzy nie wolno
 * wysyłać ponownie.
 */
export async function findOpenKsefSubmission(
  tenantId: string,
  invoiceId: string,
): Promise<KsefSubmissionReferences | null> {
  const { data, error } = await createAdminClient()
    .from('ksef_submissions')
    .select('session_reference_number, invoice_reference_number, xml_storage_path, attempted_at, request_payload_hash, original_ksef_number, original_session_reference_number')
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId)
    .eq('status', 'sent')
    .not('invoice_reference_number', 'is', null)
    .order('attempted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('Nie można odczytać historii wysyłki KSeF');
  if (!data?.session_reference_number || !data.invoice_reference_number) return null;
  return {
    sessionReferenceNumber: data.session_reference_number,
    invoiceReferenceNumber: data.invoice_reference_number,
    xmlStoragePath: data.xml_storage_path ?? null,
    attemptedAt: data.attempted_at ?? null,
    payloadHash: data.request_payload_hash ?? null,
    originalKsefNumber: data.original_ksef_number ?? null,
    originalSessionReferenceNumber: data.original_session_reference_number ?? null,
  };
}

/**
 * Klucz XML próby, która poszła w danej sesji KSeF (własny duplikat 440, D5).
 * `null`, gdy wpis jest sprzed 00134 albo sesja nie należy do tej faktury.
 */
export async function findOwnKsefSessionXmlPath(
  tenantId: string,
  invoiceId: string,
  sessionReferenceNumber: string,
): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from('ksef_submissions')
    .select('xml_storage_path')
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId)
    .eq('session_reference_number', sessionReferenceNumber)
    .not('xml_storage_path', 'is', null)
    .order('attempted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('Nie można odczytać historii wysyłki KSeF');
  return data?.xml_storage_path ?? null;
}

/** Czy ta sesja KSeF należy do wysyłek tej faktury (rozpoznanie własnego duplikatu 440). */
export async function isOwnKsefSession(
  tenantId: string,
  invoiceId: string,
  sessionReferenceNumber: string,
): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from('ksef_submissions')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId)
    .eq('session_reference_number', sessionReferenceNumber)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('Nie można odczytać historii wysyłki KSeF');
  return Boolean(data);
}

/** Numer sesji, w której faktura dostała dany numer KSeF — do pobrania UPO. */
export async function findSessionReferenceForKsefNumber(
  tenantId: string,
  invoiceId: string,
  ksefNumber: string,
): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from('ksef_submissions')
    .select('session_reference_number')
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId)
    .eq('response_ksef_number', ksefNumber)
    .not('session_reference_number', 'is', null)
    .order('attempted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('Nie można odczytać historii wysyłki KSeF');
  return data?.session_reference_number ?? null;
}

// ─────────────────────────────────────────────────────────────────
// D-A4-1: cudzy 440 — weryfikacja treści oryginału
// ─────────────────────────────────────────────────────────────────

/** Pliki wszystkich prób tej faktury (skrót hex i klucz) — do rozpoznania naszego pliku w KSeF. */
export async function findSubmissionPayloads(
  tenantId: string,
  invoiceId: string,
): Promise<Array<{ hash: string; xmlStoragePath: string | null }>> {
  const { data, error } = await createAdminClient()
    .from('ksef_submissions')
    .select('request_payload_hash, xml_storage_path')
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId)
    .not('request_payload_hash', 'is', null);
  if (error) throw new Error('Nie można odczytać historii wysyłki KSeF');
  return (data ?? [])
    .filter((r) => typeof r.request_payload_hash === 'string' && r.request_payload_hash)
    .map((r) => ({ hash: r.request_payload_hash as string, xmlStoragePath: (r.xml_storage_path as string | null) ?? null }));
}

export interface KsefSessionRow {
  status: string | null;
  requestPayloadHash: string | null;
  xmlStoragePath: string | null;
  invoiceReferenceNumber: string | null;
}

/** Wpis tej faktury z danej sesji (najnowszy) — skrót i plik próby. */
export async function findKsefSessionRow(
  tenantId: string,
  invoiceId: string,
  sessionReferenceNumber: string,
): Promise<KsefSessionRow | null> {
  const { data, error } = await createAdminClient()
    .from('ksef_submissions')
    .select('status, request_payload_hash, xml_storage_path, invoice_reference_number')
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId)
    .eq('session_reference_number', sessionReferenceNumber)
    .order('attempted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('Nie można odczytać historii wysyłki KSeF');
  if (!data) return null;
  return {
    status: data.status ?? null,
    requestPayloadHash: data.request_payload_hash ?? null,
    xmlStoragePath: data.xml_storage_path ?? null,
    invoiceReferenceNumber: data.invoice_reference_number ?? null,
  };
}

/**
 * D-A4-1: KSeF odpowiedział na tę próbę 440 — zapisujemy numer i sesję
 * oryginału na OTWARTYM wpisie (status `sent`, także z zamiaru), zanim
 * zaczniemy weryfikację. Wpis zostaje dowodem kontaktu do werdyktu, a każde
 * kolejne uzgodnienie (cron I5, „Tylko uzgodnij”) weryfikuje treść od nowa
 * zamiast pytać o starą sesję — inaczej po 48 h zostałby zamknięty jako
 * STALE i faktura dostałaby fałszywe „KSeF nie ma tej faktury”.
 * Rzuca przy błędzie bazy (fail-closed).
 */
export async function markKsefAttemptDuplicatePending(params: {
  tenantId: string;
  invoiceId: string;
  sessionReferenceNumber: string;
  invoiceReferenceNumber?: string | null;
  originalKsefNumber: string;
  originalSessionReferenceNumber?: string | null;
}): Promise<void> {
  const patch: Record<string, unknown> = {
    status: 'sent' satisfies SubmissionStatus,
    error_code: '440',
    original_ksef_number: params.originalKsefNumber,
    original_session_reference_number: params.originalSessionReferenceNumber ?? null,
  };
  if (params.invoiceReferenceNumber) patch.invoice_reference_number = params.invoiceReferenceNumber;
  const { error } = await createAdminClient()
    .from('ksef_submissions')
    .update(patch)
    .eq('tenant_id', params.tenantId)
    .eq('invoice_id', params.invoiceId)
    .eq('session_reference_number', params.sessionReferenceNumber)
    .in('status', ['intent', 'sent']);
  if (error) throw new Error('Nie można zapisać odpowiedzi 440 w historii wysyłki KSeF');
}

/**
 * Zamknięcie naszej próby z danej sesji (otwarty zamiar albo wpis `sent`) —
 * np. jako `duplicate` po werdykcie. Rzuca przy błędzie bazy.
 */
export async function closeKsefAttempt(params: {
  tenantId: string;
  invoiceId: string;
  sessionReferenceNumber: string;
  invoiceReferenceNumber?: string | null;
  status: 'duplicate';
  errorCode: string;
  errorMessage: string;
}): Promise<void> {
  const patch: Record<string, unknown> = {
    status: params.status satisfies SubmissionStatus,
    error_code: params.errorCode.slice(0, 20),
    error_message: params.errorMessage.slice(0, 500),
    completed_at: new Date().toISOString(),
  };
  if (params.invoiceReferenceNumber) patch.invoice_reference_number = params.invoiceReferenceNumber;
  const { error } = await createAdminClient()
    .from('ksef_submissions')
    .update(patch)
    .eq('tenant_id', params.tenantId)
    .eq('invoice_id', params.invoiceId)
    .eq('session_reference_number', params.sessionReferenceNumber)
    .in('status', ['intent', 'sent']);
  if (error) throw new Error('Nie można zamknąć wpisu historii wysyłki KSeF');
}

/**
 * Werdykt „numer zajęty” (D-A4-1): WSZYSTKIE próby tej faktury, które mogą
 * dotyczyć tego oryginału (zamiar, otwarty `sent`, `duplicate`), dostają
 * `number_taken` — inaczej starszy wpis `duplicate` zostałby dowodem kontaktu
 * i powrót do szkicu byłby zablokowany. Bezpieczne: oryginał o tym numerze
 * jest jeden, a treść faktury z dowodem kontaktu jest zamrożona (00132).
 * Rzuca przy błędzie bazy (fail-closed — runner ponowi weryfikację).
 */
export async function markKsefSubmissionsNumberTaken(params: {
  tenantId: string;
  invoiceId: string;
  originalKsefNumber: string;
}): Promise<void> {
  const { error } = await createAdminClient()
    .from('ksef_submissions')
    .update({
      status: 'number_taken' satisfies SubmissionStatus,
      error_code: 'NUMBER_TAKEN',
      error_message: `Numer faktury zajęty w KSeF przez fakturę ${params.originalKsefNumber} spoza FaktWay`.slice(0, 500),
      completed_at: new Date().toISOString(),
    })
    .eq('tenant_id', params.tenantId)
    .eq('invoice_id', params.invoiceId)
    .in('status', ['intent', 'sent', 'duplicate']);
  if (error) throw new Error('Nie można zapisać werdyktu „numer zajęty” w historii wysyłki KSeF');
}

/** Szkic wycofany (wpis `number_taken`): numer KSeF oryginału i decyzja klienta, jeśli była. */
export interface KsefNumberTaken {
  /** K — `null`, gdy faktura ma tylko wpisy `number_taken` bez znacznika 440. */
  originalKsefNumber: string | null;
  /** `original_check.decision.choice` (00148); `null` — automatyczny „numer zajęty”. */
  decision: DuplicateDecisionChoice | null;
  /**
   * PR C (00156, 5.4): `decision.importedInvoiceId` — faktura K zapisana z KSeF,
   * na którą przeszedł numer (szkic wycofany bez numeru; PDF i e-mail odsyłają
   * do PDF K, 5.12). `null` — decyzja bez zapisu oryginału albo jej brak.
   */
  importedInvoiceId: string | null;
  /** PR C: `decision.retiredInternalNumber` — dawny numer dokumentu (`{nrOld}`). */
  retiredInternalNumber: string | null;
  /** PR C: `decision.offer` (znana oferta); `null` przy decyzjach PR B. */
  offer: DuplicateOriginalOffer | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function takenDecision(check: unknown): DuplicateDecisionChoice | null {
  if (!isRecord(check) || !isRecord(check.decision)) return null;
  const choice = check.decision.choice;
  return choice === 'same_sale' || choice === 'other_sale' ? choice : null;
}

/** Klucze decyzji z zapisem oryginału (00156) — tylko poprawne wartości (id jak wzorzec I3K), reszta `null`. */
function takenImport(check: unknown): Pick<KsefNumberTaken, 'importedInvoiceId' | 'retiredInternalNumber' | 'offer'> {
  const decision = isRecord(check) && isRecord(check.decision) ? check.decision : null;
  const imported = decision?.importedInvoiceId;
  const retired = decision?.retiredInternalNumber;
  const offer = decision?.offer;
  return {
    importedInvoiceId: typeof imported === 'string' && UUID.test(imported) ? imported : null,
    retiredInternalNumber: typeof retired === 'string' && retired.trim() !== '' ? retired : null,
    offer: typeof offer === 'string' && (DUPLICATE_ORIGINAL_OFFERS as readonly string[]).includes(offer)
      ? (offer as DuplicateOriginalOffer)
      : null,
  };
}

/** Czas do sortowania (ms) i mikrosekundy ponad ms (`timestamptz` z PostgREST ma 6 cyfr ułamka). */
function timeOf(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}
function microsOf(value: string | null): number {
  const m = value ? /:\d{2}\.\d{3}(\d{1,3})/.exec(value) : null;
  return m ? Number(m[1]!.padEnd(3, '0')) : 0;
}

/**
 * D-A4-1b-3 PR B (decyzje Bartosza 07.10.2026 (2), (3)): czy faktura jest
 * szkicem wycofanym — ma wpis `number_taken` (decyzja klienta „ta sama /
 * inna sprzedaż” albo automatyczny werdykt KSEF_NUMBER_TAKEN). Numer jest
 * zajęty w KSeF, więc runner kończy taki job bez zapisu, a e-maila do
 * nabywcy nie wysyłamy.
 *
 * Wybór wpisu jak w wyzwalaczu `guard_ksef_retired_draft` (00148, krok 2):
 * najpierw z decyzją, potem z numerem oryginału (`markKsefSubmissionsNumberTaken`
 * zamyka też wpisy bez znacznika), potem `completed_at` malejąco (brak na
 * końcu), potem `id`. Sortowanie w TypeScript — w zapytaniu tylko `.eq`.
 * Filtr po firmie I fakturze. Rzuca przy błędzie bazy (fail-closed:
 * „nie wiem” to nie „zwykły szkic”).
 */
export async function findKsefNumberTaken(tenantId: string, invoiceId: string): Promise<KsefNumberTaken | null> {
  const { data, error } = await createAdminClient()
    .from('ksef_submissions')
    // `original_check` z 00144 — typy bazy dogenerujemy z produkcji po wgraniu.
    .select('id, original_ksef_number, original_check, completed_at')
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId)
    .eq('status', 'number_taken' satisfies SubmissionStatus);
  if (error) throw new Error('Nie można sprawdzić, czy numer faktury jest zajęty w KSeF (historia wysyłki)');
  type TakenRow = { id: string; original_ksef_number: string | null; original_check: unknown; completed_at: string | null };
  const rows = ((data ?? []) as unknown as TakenRow[]).map((r) => ({
    ...r,
    decided: isRecord(r.original_check) && Object.prototype.hasOwnProperty.call(r.original_check, 'decision'),
  }));
  if (rows.length === 0) return null;
  rows.sort((a, b) => {
    if (a.decided !== b.decided) return a.decided ? -1 : 1;
    const withKa = a.original_ksef_number != null;
    const withKb = b.original_ksef_number != null;
    if (withKa !== withKb) return withKa ? -1 : 1;
    const ta = timeOf(a.completed_at);
    const tb = timeOf(b.completed_at);
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
    if (ta !== null) {
      const micro = microsOf(b.completed_at) - microsOf(a.completed_at);
      if (micro !== 0) return micro;
    }
    return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
  });
  const row = rows[0]!;
  return {
    originalKsefNumber: row.original_ksef_number ?? null,
    decision: takenDecision(row.original_check),
    ...takenImport(row.original_check),
  };
}

/**
 * Sesja, w której faktura dostała numer KSeF — wpis `accepted` z
 * `response_ksef_number`, żeby ponowienia UPO (`upo-retry-stale` →
 * `findSessionReferenceForKsefNumber`) znalazły sesję także wtedy, gdy numer
 * przyjęliśmy z duplikatu (własnego albo zweryfikowanego treścią).
 * Rzuca przy błędzie bazy — wywołujący decyduje (akceptacji to nie cofa).
 */
export async function recordKsefAcceptedSession(params: {
  tenantId: string;
  invoiceId: string;
  sessionReferenceNumber: string;
  ksefNumber: string;
  xmlStoragePath?: string | null;
  payloadHash?: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from('ksef_submissions')
    .update({
      status: 'accepted' satisfies SubmissionStatus,
      response_ksef_number: params.ksefNumber,
      completed_at: new Date().toISOString(),
    })
    .eq('tenant_id', params.tenantId)
    .eq('invoice_id', params.invoiceId)
    .eq('session_reference_number', params.sessionReferenceNumber)
    .select('id');
  if (error) throw new Error('Nie można zapisać sesji przyjętej faktury');
  if (Array.isArray(updated) && updated.length > 0) return;
  const { error: insertError } = await admin.from('ksef_submissions').insert({
    tenant_id: params.tenantId,
    invoice_id: params.invoiceId,
    submission_type: 'online',
    status: 'accepted' satisfies SubmissionStatus,
    session_reference_number: params.sessionReferenceNumber,
    invoice_reference_number: null,
    response_ksef_number: params.ksefNumber,
    request_payload_hash: params.payloadHash ?? null,
    xml_storage_path: params.xmlStoragePath ?? null,
    completed_at: new Date().toISOString(),
  });
  if (insertError) throw new Error('Nie można zapisać sesji przyjętej faktury');
}

/**
 * Inna faktura SPRZEDAŻY tej firmy z danym numerem KSeF (np. import historii)
 * — wtedy cudzy 440 dotyczy dokumentu znanego w FaktWay i rozstrzyga
 * operator. Tylko wychodzące (D-A4-1b-3, A0): faktura zakupowa z tym numerem
 * (np. sprzedaż firmy samej sobie odebrana skrzynką) nie jest zapisem naszej
 * sprzedaży i nie może zatrzymać porównania treści oryginału.
 */
export async function findTenantInvoiceByKsefNumber(
  tenantId: string,
  ksefNumber: string,
  excludeInvoiceId: string,
): Promise<{ id: string; internalNumber: string | null } | null> {
  const { data, error } = await createAdminClient()
    .from('invoices')
    .select('id, internal_number')
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_number', ksefNumber)
    .neq('id', excludeInvoiceId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('Nie można sprawdzić numeru KSeF w fakturach firmy');
  return data ? { id: data.id as string, internalNumber: (data.internal_number as string | null) ?? null } : null;
}

/** Ile razy `recordKsefDuplicateCheck` scala od nowa, gdy SQL zmienił znacznik między odczytem a zapisem. */
const DUPLICATE_CHECK_WRITE_ATTEMPTS = 3;

/**
 * Klucze `original_check`, które dopisuje SQL pod blokadą wiersza, gdy runner
 * nie trzyma wysyłki (00156): `importGate.release` (`release_ksef_original_review`,
 * 4.7 krok 8) i `recheckNeeded` (`flag_ksef_original_recheck`, 4.7b krok 5).
 * Oba tylko dochodzą (raz zapisane — `already_released` / `already`), więc
 * „wiersz bez klucza w chwili zapisu” znaczy „wiersz bez zmian od odczytu”.
 * Ścieżki PostgREST (`->`, `->>`): brak klucza i JSON `null` dają SQL-owy NULL.
 */
const SQL_WRITTEN_CHECK_PATHS = [
  { path: 'original_check->importGate->>release', present: (c: Record<string, unknown>) => isRecord(c.importGate) && c.importGate.release != null },
  { path: 'original_check->>recheckNeeded', present: (c: Record<string, unknown>) => c.recheckNeeded != null },
] as const;

/**
 * D-A4-1b-3 (00144): dane oryginału przy duplikacie 440, którego automat nie
 * rozstrzygnął — na otwartym wpisie próby ze znacznikiem 440 tego numeru KSeF.
 * Zamknięte wpisy (decyzja, `number_taken`, akceptacja) nie są nadpisywane.
 * Rzuca przy błędzie bazy (fail-closed: bez danych nie ma werdyktu).
 *
 * PR C (rozstrzygnięcia commitu 3, fix 5; INV-25, INV-26): zapis warunkowy.
 * Runner trzyma wysyłkę (00124), ale `release_ksef_original_review`
 * i `flag_ksef_original_recheck` (operator, akcja klienta) piszą znacznik bez
 * przejęcia. Zapis bez warunku nadpisałby je starszym obrazem — zgubione
 * oddanie decyzji albo zgubiony `recheckNeeded`. Dlatego UPDATE trafia tylko
 * w wiersz, który nadal nie ma kluczy nieobecnych przy odczycie; gdy znacznik
 * się zmienił (zero zapisanych wierszy, a wiersz jest), ponowny odczyt
 * i ponowne scalenie `mergeDuplicateCheck` — ono decyduje, co z oddania
 * i znacznika przechodzi do nowego zapisu. Postgres sprawdza warunek UPDATE
 * jeszcze raz po zdjęciu blokady wiersza, więc zapis nie mija się z SQL.
 */
export async function recordKsefDuplicateCheck(params: {
  tenantId: string;
  invoiceId: string;
  originalKsefNumber: string;
  check: KsefDuplicateCheck;
}): Promise<void> {
  const supabase = createAdminClient();
  // Sprawdzenie, które nie pobrało oryginału, nie kasuje danych z wcześniejszego
  // udanego (`mergeDuplicateCheck`) — odczyt bieżącego zapisu przed nadpisaniem.
  for (let attempt = 1; attempt <= DUPLICATE_CHECK_WRITE_ATTEMPTS; attempt++) {
    const { data: current, error: readError } = await supabase
      .from('ksef_submissions')
      // `original_check` z 00144 — typy bazy dogenerujemy z produkcji po wgraniu.
      .select('id, original_check')
      .eq('tenant_id', params.tenantId)
      .eq('invoice_id', params.invoiceId)
      .eq('original_ksef_number', params.originalKsefNumber)
      .in('status', ['intent', 'sent'])
      .order('attempted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (readError) throw new Error('Nie można odczytać danych oryginału duplikatu KSeF');
    const row = current as { id?: unknown; original_check?: unknown } | null;
    // Brak otwartego wpisu (decyzja albo werdykt go zamknęły) — nic do zapisu, jak dotąd.
    if (!row) return;
    const raw = isRecord(row.original_check) ? row.original_check : {};
    const previous = parseDuplicateCheck(row.original_check);

    let update = supabase
      .from('ksef_submissions')
      .update({ original_check: mergeDuplicateCheck(previous, params.check) } as Record<string, unknown>)
      .eq('tenant_id', params.tenantId)
      .eq('invoice_id', params.invoiceId)
      .eq('original_ksef_number', params.originalKsefNumber)
      .in('status', ['intent', 'sent']);
    for (const { path, present } of SQL_WRITTEN_CHECK_PATHS) {
      if (!present(raw)) update = update.is(path, null);
    }
    const { data: written, error } = await update.select('id');
    if (error) throw new Error('Nie można zapisać danych oryginału duplikatu KSeF');
    const ids = Array.isArray(written) ? (written as Array<{ id?: unknown }>).map((r) => r.id) : [];
    // Odczytany znacznik dostał nasz zapis — reszta otwartych wpisów tego numeru (jeśli są) też, o ile się nie zmieniły.
    if (ids.includes(row.id)) return;
  }
  // SQL zmieniał znacznik przy każdej próbie — fail-closed, runner ponowi werdykt od zera.
  throw new Error('Nie można zapisać danych oryginału duplikatu KSeF — znacznik zmieniał się w trakcie zapisu');
}
