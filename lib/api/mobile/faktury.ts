import 'server-only';

import { revalidatePath } from 'next/cache';
import type { NextResponse } from 'next/server';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type {
  FakturaZapisana,
  PodpowiedzFakturyOdpowiedz,
  WystawienieOdpowiedz,
  WysylkaSzkicuOdpowiedz,
} from '@/lib/api/mobile/kontrakt';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { doWartosciFormularza, sciezkaPola, wystawienieSchema } from '@/lib/api/mobile/schematy';
import { requestDigest } from '@/lib/api/v1/invoice-create';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  parseRegularInvoiceForm,
  readTenantSnapshot,
  saveAndSendRegularInvoice,
  saveRegularDraft,
  type RegularIssueContext,
  type RegularIssueResult,
} from '@/lib/invoices/issue-regular';
import type { TokenSessionSendActor } from '@/lib/invoices/ksef-submit-enqueue';
import { suggestNextInvoiceNumberForTenant } from '@/lib/invoices/next-number';
import { sendRegularDraft } from '@/lib/invoices/send-draft';
import { readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { isUuid } from '@/lib/supabase/active-org';

/**
 * Faktury z telefonu (plan aplikacji mobilnej, M8): szybka faktura (szkic albo
 * „Wyślij do KSeF”), wysyłka szkicu i podpowiedź do pustego formularza.
 *
 * Te same funkcje co akcje strony (`lib/invoices/issue-regular.ts`,
 * `lib/invoices/send-draft.ts`), na kliencie z tokenem telefonu (RLS jak na
 * stronie) i z 2FA z tokenu (`tokenSession`).
 *
 * Ponowienie `POST /faktury` (protokół naprawy, punkt 5). Klucz z nagłówka
 * `Idempotency-Key` (UUID na jedno wypełnienie formularza) trafia do
 * `mobile_idempotency_keys` (00201) zaraz po zapisie szkicu, przed kolejką KSeF:
 *  - po każdym kroku ponowienie z tym samym kluczem i tą samą treścią oddaje
 *    tę samą fakturę (200, `powtorzenie: true`);
 *  - przerwa po szkicu, przed kluczem: ponowienie trafia na zajęty numer
 *    faktury (unikalny w firmie) i dostaje 422 z numerem, drugiej faktury nie ma;
 *  - przerwa po kluczu, przed kolejką (albo kolejka odmówiła): ponowienie
 *    z `wyslij: true` zleca wysyłkę szkicu jak „Wyślij” (RPC przejmuje tylko szkic);
 *  - po kolejce: ponowienie widzi stan inny niż szkic i niczego nie zleca;
 *  - ten sam klucz z inną treścią: 409 `idempotency_conflict`.
 */

/** Największa treść żądania (jak publiczne API: 1000 pozycji z długimi nazwami z zapasem). */
const MAX_BODY_BYTES = 1_000_000;
const ENDPOINT = 'POST /api/mobile/v1/faktury';

/** Stany, w których wysyłka już jest zlecona albo zakończona sukcesem (`statusZBazy` w telefonie). */
const SEND_IN_PROGRESS_OR_DONE = new Set(['pending', 'queued', 'sending', 'offline_queued', 'accepted']);

type Db = RegularIssueContext['supabase'];

/** Stan 2FA tokenu dla kolejki: sesja konta z TOTP jest po kodzie (inaczej bramka dała 403). */
function tokenSessionOf(caller: MobileCaller): TokenSessionSendActor {
  return { mfa: caller.mfaEnabled ? 'verified' : 'enrollment_required' };
}

function dbOf(caller: MobileCaller): Db {
  return caller.db as unknown as Db;
}

function tenantOf(caller: MobileCaller): string {
  if (!caller.org) throw new Error('Trasa faktur bez firmy (org: required)');
  return caller.org.tenantId;
}

async function readSaved(db: Db, tenantId: string, invoiceId: string): Promise<FakturaZapisana | null> {
  const { data, error } = await db
    .from('invoices')
    .select('id, internal_number, ksef_status')
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new MobileUpstreamError('invoices.read');
  if (!data) return null;
  return { id: String(data.id), numer: String(data.internal_number ?? ''), ksefStatus: String(data.ksef_status ?? 'draft') };
}

interface KeyRow {
  request_hash: string;
  invoice_id: string;
}

async function findKey(db: Db, tenantId: string, userId: string, key: string): Promise<KeyRow | null> {
  const { data, error } = await db
    .from('mobile_idempotency_keys' as never)
    .select('request_hash, invoice_id')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('idempotency_key', key)
    .maybeSingle();
  if (error) throw new MobileUpstreamError('mobile_idempotency_keys.read');
  return (data as KeyRow | null) ?? null;
}

const KEY_SAVE_FAILED =
  'Szkic faktury jest zapisany, ale nie wysłaliśmy go do KSeF, bo nie udało się zapisać zabezpieczenia przed podwójną wysyłką. Otwórz szkic na liście faktur i wyślij go jeszcze raz.';

async function saveKey(db: Db, tenantId: string, userId: string, key: string, hash: string, invoiceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await db.from('mobile_idempotency_keys' as never).insert({
    tenant_id: tenantId,
    user_id: userId,
    idempotency_key: key,
    request_hash: hash,
    endpoint: ENDPOINT,
    invoice_id: invoiceId,
  } as never);
  return error ? { ok: false, error: KEY_SAVE_FAILED } : { ok: true };
}

type Body = { ok: true; value: unknown } | { ok: false; response: NextResponse };

async function readJson(request: Request, headers: Record<string, string>): Promise<Body> {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    return { ok: false, response: mobileError(400, 'invalid_request', 'Treść żądania to JSON (Content-Type: application/json).', headers) };
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  const text = Number.isFinite(declared) && declared > MAX_BODY_BYTES ? null : await request.text();
  if (text === null || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, response: mobileError(400, 'invalid_request', 'Faktura jest za duża do wysłania z telefonu. Wystaw ją na faktway.pl.', headers) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: mobileError(400, 'invalid_request', 'Treść żądania nie jest poprawnym JSON.', headers) };
  }
}

const MISSING_KEY = 'Brak klucza zapisu (Idempotency-Key). Zaktualizuj aplikację FaktWay i spróbuj ponownie.';
const KEY_CONFLICT =
  'Ta faktura została już zapisana z innymi danymi. Otwórz ją na liście faktur albo zacznij nową fakturę.';
const NOT_FOUND = 'Nie znaleziono tej faktury w wybranej firmie. Odśwież listę faktur.';

/** Odmowa wystawienia: zdanie z akcji strony (co poprawić), szkic tylko gdy powstał. */
function refusal(result: Extract<RegularIssueResult, { success: false }>, headers: Record<string, string>): NextResponse {
  return mobileError(422, 'invoice_invalid', result.error, headers);
}

/** Powtórzenie po kluczu: zapisana faktura; przy `wyslij` szkic idzie do kolejki jak „Wyślij”. */
async function replay(caller: MobileCaller, invoiceId: string, wyslij: boolean): Promise<NextResponse> {
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const saved = await readSaved(db, tenantId, invoiceId);
  // Klucz usuwa się razem z fakturą (ON DELETE CASCADE): tu faktura zawsze jest.
  if (!saved) throw new MobileUpstreamError('mobile_idempotency_keys.invoice');

  let wysylka: WystawienieOdpowiedz['wysylka'] = null;
  let faktura = saved;
  if (wyslij && saved.ksefStatus === 'draft') {
    const sent = await sendRegularDraft({ supabase: db, userId: caller.user.id, tenantId, tokenSession: tokenSessionOf(caller) }, invoiceId);
    wysylka = sent.success ? { zlecona: true, blad: null } : { zlecona: false, blad: sent.error };
    // Stan po zleceniu (`queued`) czytamy tylko wtedy, gdy kolejka coś zmieniła.
    if (sent.success) faktura = (await readSaved(db, tenantId, invoiceId)) ?? saved;
  } else if (wyslij) {
    wysylka = { zlecona: SEND_IN_PROGRESS_OR_DONE.has(saved.ksefStatus), blad: null };
  }
  const body: WystawienieOdpowiedz = { faktura, powtorzenie: true, wysylka };
  return mobileJson(body, 200, caller.headers);
}

/** `POST /api/mobile/v1/faktury`. */
export async function issueInvoiceFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const key = request.headers.get('idempotency-key')?.trim().toLowerCase() ?? '';
  if (!isUuid(key)) return mobileError(400, 'missing_idempotency_key', MISSING_KEY, headers);

  const raw = await readJson(request, headers);
  if (!raw.ok) return raw.response;
  const parsed = wystawienieSchema.safeParse(raw.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return mobileError(400, 'invalid_request', `Treść żądania nie pasuje do kontraktu (${sciezkaPola(issue?.path ?? []) ?? 'treść'}). Zaktualizuj aplikację FaktWay.`, headers);
  }
  const { wyslij, faktura } = parsed.data;
  const hash = requestDigest(raw.value);
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const userId = caller.user.id;

  const earlier = await findKey(db, tenantId, userId, key);
  if (earlier) {
    if (earlier.request_hash !== hash) return mobileError(409, 'idempotency_conflict', KEY_CONFLICT, headers);
    return replay(caller, earlier.invoice_id, wyslij);
  }

  // Ten sam schemat i te same komunikaty co formularz strony.
  const values = doWartosciFormularza(faktura);
  const checked = parseRegularInvoiceForm(values);
  if (!checked.ok) return mobileError(422, 'invoice_invalid', checked.error, headers, sciezkaPola(checked.path));

  const ctx: RegularIssueContext = { supabase: db, userId, tenant: await readTenantSnapshot(db, tenantId), tokenSession: tokenSessionOf(caller) };
  let keySaved = false;
  const result = wyslij
    ? await saveAndSendRegularInvoice(ctx, values, async (invoiceId) => {
        const k = await saveKey(db, tenantId, userId, key, hash, invoiceId);
        keySaved = k.ok;
        return k;
      })
    : await saveRegularDraft(ctx, values);

  if (!wyslij && result.success) {
    // Szkic bez kolejki: klucz po zapisie (przerwę między nimi łapie unikalny numer faktury).
    keySaved = (await saveKey(db, tenantId, userId, key, hash, result.invoiceId)).ok;
    revalidatePath('/invoices');
  }

  // Równoległe żądanie z tym samym kluczem zdążyło pierwsze: oddajemy jego fakturę.
  if (!keySaved) {
    const winner = await findKey(db, tenantId, userId, key);
    if (winner && winner.request_hash === hash) return replay(caller, winner.invoice_id, wyslij);
  }

  if (!result.success && !result.invoiceId) return refusal(result, headers);

  const invoiceId = result.success ? result.invoiceId : result.invoiceId!;
  const saved = await readSaved(db, tenantId, invoiceId);
  if (!saved) throw new MobileUpstreamError('invoices.after_save');
  const body: WystawienieOdpowiedz = {
    faktura: saved,
    powtorzenie: false,
    wysylka: wyslij ? (result.success ? { zlecona: true, blad: null } : { zlecona: false, blad: result.error }) : null,
  };
  return mobileJson(body, 201, headers);
}

/** `POST /api/mobile/v1/faktury/{id}/wysylka`. */
export async function sendDraftFromMobile(caller: MobileCaller, invoiceId: string): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(invoiceId)) return mobileError(404, 'not_found', NOT_FOUND, headers);
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);

  const sent = await sendRegularDraft({ supabase: db, userId: caller.user.id, tenantId, tokenSession: tokenSessionOf(caller) }, invoiceId.toLowerCase());
  if (!sent.success) {
    if (sent.reason === 'not_found') return mobileError(404, 'not_found', NOT_FOUND, headers);
    if (sent.reason === 'not_draft') {
      const saved = await readSaved(db, tenantId, invoiceId.toLowerCase());
      // Ponowienie po zerwanym połączeniu: wysyłka już zlecona, nic nie wysyłamy drugi raz.
      if (saved && SEND_IN_PROGRESS_OR_DONE.has(saved.ksefStatus)) {
        const body: WysylkaSzkicuOdpowiedz = { faktura: saved, juzZlecona: true };
        return mobileJson(body, 200, headers);
      }
      return mobileError(409, 'not_draft', 'Ta faktura nie jest szkicem. Odrzuconą albo z błędem wysyłki popraw na faktway.pl.', headers);
    }
    return mobileError(422, 'ksef_send_refused', sent.error, headers);
  }
  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId.toLowerCase()}`);
  const saved = await readSaved(db, tenantId, invoiceId.toLowerCase());
  if (!saved) throw new MobileUpstreamError('invoices.after_send');
  const body: WysylkaSzkicuOdpowiedz = { faktura: saved, juzZlecona: false };
  return mobileJson(body, 200, headers);
}

/** `GET /api/mobile/v1/faktury/podpowiedz`: numer, dziś i zwolnienie z VAT, jak pusty formularz strony. */
export async function invoiceFormHint(caller: MobileCaller): Promise<NextResponse> {
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const dzis = todayInWarsaw();
  const [numer, zwolnienie] = await Promise.all([
    suggestNextInvoiceNumberForTenant(db, tenantId, dzis),
    readTenantVatExemption(db, tenantId),
  ]);
  const body: PodpowiedzFakturyOdpowiedz = { numer, dzis, zwolnienieVat: zwolnienie !== null };
  return mobileJson(body, 200, caller.headers);
}
