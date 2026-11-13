import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type {
  NaleznosciOdpowiedz,
  NaleznoscTelefonu,
  PdfFakturyOdpowiedz,
  PodgladPrzypomnieniaOdpowiedz,
  SprawdzenieSkrzynkiOdpowiedz,
  WstrzymanieOdpowiedz,
  ZaplataOdpowiedz,
  ZatwierdzeniePrzypomnieniaOdpowiedz,
} from '@/lib/api/mobile/kontrakt';
import { mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { APPROVAL_ROLE_REFUSAL, approveFloProposal, mayApproveProposal } from '@/lib/flo/approve-proposal';
import { isApprovalVersion } from '@/lib/flo/approval-version';
import { EXECUTION_FAILED_MESSAGE } from '@/lib/flo/execute';
import { markInvoicePaid, mayChangePayment, PAYMENT_ROLE_REFUSAL, undoInvoicePaid } from '@/lib/invoices/mark-paid';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { requestInboxCheck } from '@/lib/ksef/inbox-check';
import { loadOverdueOverview, type OverdueInvoice } from '@/lib/overdue/load-overdue';
import { generateInvoicePdf } from '@/lib/pdf/invoice-pdf';
import { setInvoiceRemindersPaused } from '@/lib/reminders/pause';
import { PREPARE_REMINDER_FAILED, PREPARE_REMINDER_INVALID, prepareReminderPreview, prepareReminderSchema } from '@/lib/reminders/prepare-preview';
import { isUuid } from '@/lib/supabase/active-org';
import type { Database } from '@/types/database';

/**
 * Należności z telefonu (plan aplikacji mobilnej, M10a): lista „Po terminie”,
 * zapłata i jej cofnięcie, przypomnienie (podgląd, zgoda, wstrzymanie), PDF
 * faktury i „Sprawdź teraz” w skrzynce KSeF.
 *
 * Każda funkcja to ta sama funkcja z `lib/` co na stronie, na kliencie z
 * tokenem telefonu w jego aktywnej firmie (RLS jak na stronie). Rola w firmie
 * z bramki (`caller.org.role`, członkostwo sprawdzone tokenem), z tymi samymi
 * odmowami co akcje strony; RPC sprawdzają rolę jeszcze raz w bazie.
 *
 * Ponowienie po zerwanym połączeniu:
 *  - zapłata i cofnięcie: RPC 00158 są idempotentne (`already_paid`,
 *    `nothing_to_undo`): telefon dostaje `juzBylo: true`, zdarzenie wpłaty,
 *    analityka i webhook idą tylko raz, po pierwszej zmianie;
 *  - podgląd przypomnienia: nowy szkic, nic nie wychodzi; zatwierdzić można
 *    tylko obejrzaną wersję;
 *  - zatwierdzenie: żeton zgody jest jeden na propozycję, drugie zatwierdzenie
 *    to „Ta sprawa jest już w toku” bez drugiej wysyłki, a etap ma zapis
 *    zlecenia (`hasReminderDispatch`);
 *  - wstrzymanie: ustawia ten sam stan;
 *  - PDF i lista: tylko odczyt; „Sprawdź teraz”: limit 5 minut na firmę.
 */

const NOT_FOUND = 'Nie znaleziono tej faktury w wybranej firmie. Odśwież listę faktur.';
const MAX_BODY_BYTES = 100_000;
const TOO_LARGE = 'Treść jest za długa do wysłania z telefonu.';

type Db = SupabaseClient<Database>;

function dbOf(caller: MobileCaller): Db {
  return caller.db as unknown as Db;
}

function orgOf(caller: MobileCaller): NonNullable<MobileCaller['org']> {
  if (!caller.org) throw new Error('Trasa należności bez firmy (org: required)');
  return caller.org;
}

function body(request: Request, caller: MobileCaller, optional = false) {
  return readJsonBody(request, caller.headers, { maxBytes: MAX_BODY_BYTES, tooLarge: TOO_LARGE, optional });
}

function badShape(caller: MobileCaller): NextResponse {
  return mobileError(400, 'invalid_request', 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.', caller.headers);
}

// ─── Lista „Po terminie” ──────────────────────────────────────────────

const KOLEJKA: Record<OverdueInvoice['reminder_status'], NaleznoscTelefonu['kolejka']> = {
  none: 'brak',
  pending: 'zaplanowane',
  review: 'do_sprawdzenia',
  unavailable: 'nieznany',
};

function naleznosc(invoice: OverdueInvoice): NaleznoscTelefonu {
  const latest = invoice.latest_reminder;
  return {
    id: invoice.id,
    numer: invoice.internal_number,
    kontrahent: invoice.buyer_name,
    nip: invoice.buyer_nip || null,
    email: invoice.buyer_email || null,
    termin: invoice.payment_due_date,
    brutto: invoice.gross_total,
    doZaplaty: invoice.amount_due,
    dniPoTerminie: invoice.days_overdue,
    wstrzymane: invoice.reminders_paused,
    wyslane: invoice.reminders_sent_count,
    kolejka: KOLEJKA[invoice.reminder_status],
    ostatnie: latest === 'unavailable' ? 'nieznany' : latest ? { status: latest.status, etap: latest.stage, kiedy: latest.scheduledFor } : null,
  };
}

/** `GET /api/mobile/v1/naleznosci`. */
export async function overdueForMobile(caller: MobileCaller): Promise<NextResponse> {
  const org = orgOf(caller);
  const overview = await loadOverdueOverview(dbOf(caller), org.tenantId, requireConfiguredKsefEnvironment());
  const role = { mozeOznaczac: mayChangePayment(org.role), mozeZatwierdzac: mayApproveProposal(org.role) };
  const odpowiedz: NaleznosciOdpowiedz = overview.ok
    ? { faktury: overview.invoices.map(naleznosc), blad: null, limit: overview.limitReached, wyslaneWMiesiacu: overview.sentThisMonth, ...role }
    : { faktury: [], blad: overview.error, limit: false, wyslaneWMiesiacu: null, ...role };
  return mobileJson(odpowiedz, 200, caller.headers);
}

// ─── Zapłata ──────────────────────────────────────────────────────────

const zaplataSchema = z.object({ dzien: z.string().optional() }).strict();

/** `POST /api/mobile/v1/faktury/{id}/zaplata`. */
export async function markPaidFromMobile(caller: MobileCaller, invoiceId: string, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(invoiceId)) return mobileError(404, 'not_found', NOT_FOUND, headers);
  const org = orgOf(caller);
  if (!mayChangePayment(org.role)) return mobileError(403, 'forbidden', PAYMENT_ROLE_REFUSAL.mark, headers);
  const raw = await body(request, caller, true);
  if (!raw.ok) return raw.response;
  const parsed = zaplataSchema.safeParse(raw.value);
  if (!parsed.success) return badShape(caller);

  const result = await markInvoicePaid(
    { supabase: dbOf(caller), tenantId: org.tenantId, userId: caller.user.id, role: org.role },
    invoiceId.toLowerCase(),
    parsed.data.dzien,
  );
  if (!result.success) return mobileError(422, 'payment_refused', result.error, headers);
  const odpowiedz: ZaplataOdpowiedz = { zaplacona: true, juzBylo: result.status === 'already_paid', numer: result.number };
  return mobileJson(odpowiedz, 200, headers);
}

/** `POST /api/mobile/v1/faktury/{id}/zaplata/cofnij`. */
export async function undoPaidFromMobile(caller: MobileCaller, invoiceId: string): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(invoiceId)) return mobileError(404, 'not_found', NOT_FOUND, headers);
  const org = orgOf(caller);
  if (!mayChangePayment(org.role)) return mobileError(403, 'forbidden', PAYMENT_ROLE_REFUSAL.mark, headers);
  const result = await undoInvoicePaid({ supabase: dbOf(caller), tenantId: org.tenantId }, invoiceId.toLowerCase());
  if (!result.success) return mobileError(422, 'payment_refused', result.error, headers);
  const odpowiedz: ZaplataOdpowiedz = { zaplacona: false, juzBylo: result.status === 'nothing_to_undo', numer: null };
  return mobileJson(odpowiedz, 200, headers);
}

// ─── Przypomnienie ────────────────────────────────────────────────────

const podgladSchema = z.object({ email: z.string().optional() }).strict();

/** `POST /api/mobile/v1/faktury/{id}/przypomnienie`: podgląd, nic nie wychodzi. */
export async function reminderPreviewFromMobile(caller: MobileCaller, invoiceId: string, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(invoiceId)) return mobileError(404, 'not_found', NOT_FOUND, headers);
  const org = orgOf(caller);
  const raw = await body(request, caller, true);
  if (!raw.ok) return raw.response;
  const shape = podgladSchema.safeParse(raw.value);
  if (!shape.success) return badShape(caller);
  const email = shape.data.email?.trim();
  // Ten sam schemat co akcja strony (adres e-mail, identyfikator).
  const parsed = prepareReminderSchema.safeParse({ invoiceId: invoiceId.toLowerCase(), ...(email ? { recipientEmail: email } : {}) });
  if (!parsed.success) return mobileError(422, 'reminder_refused', PREPARE_REMINDER_INVALID, headers);

  let result: Awaited<ReturnType<typeof prepareReminderPreview>>;
  try {
    result = await prepareReminderPreview({ supabase: dbOf(caller), tenantId: org.tenantId, userId: caller.user.id }, parsed.data);
  } catch {
    // Jak akcja strony: nieoczekiwany błąd przygotowania daje to samo zdanie, bez szczegółów.
    return mobileError(422, 'reminder_refused', PREPARE_REMINDER_FAILED, headers);
  }
  if (!result.success) return mobileError(422, 'reminder_refused', result.error, headers);
  const { preview } = result;
  const odpowiedz: PodgladPrzypomnieniaOdpowiedz = {
    propozycja: result.proposalId,
    wersja: result.approvalVersion,
    wazneDo: result.expiresAt,
    od: preview.from,
    do: preview.to,
    odpowiedzNa: preview.replyTo,
    temat: preview.subject,
    tresc: preview.body,
    zalacznik: preview.attachment ? { nazwa: preview.attachment.filename, pdfBase64: preview.attachment.contentBase64 } : null,
  };
  return mobileJson(odpowiedz, 200, headers);
}

/**
 * Wysyłka padła po zgodzie (żeton zużyty, propozycja wraca do „zatwierdzonej”): drugie
 * zatwierdzenie tej samej propozycji nie przejdzie, więc klient przygotowuje nowy podgląd.
 */
export const REMINDER_DISPATCH_FAILED =
  'Nie zleciliśmy wysyłki tego przypomnienia. Przygotuj nowy podgląd i spróbuj ponownie. Jeśli błąd się powtórzy, sprawdź status przypomnienia na faktway.pl.';

const zatwierdzenieSchema = z.object({ wersja: z.string(), tresc: z.string().max(20_000) }).strict();

/** `POST /api/mobile/v1/przypomnienia/{propozycja}/zatwierdz`: zgoda na obejrzaną wersję. */
export async function approveReminderFromMobile(caller: MobileCaller, proposalId: string, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(proposalId)) return mobileError(404, 'not_found', 'Tego podglądu już nie ma. Przygotuj przypomnienie jeszcze raz.', headers);
  const org = orgOf(caller);
  const raw = await body(request, caller);
  if (!raw.ok) return raw.response;
  const parsed = zatwierdzenieSchema.safeParse(raw.value);
  if (!parsed.success || !isApprovalVersion(parsed.data.wersja) || !parsed.data.tresc.trim()) return badShape(caller);
  // Jak strona (AUD-113): wysyłkę do kontrahenta zatwierdza właściciel albo administrator.
  if (!mayApproveProposal(org.role)) return mobileError(403, 'forbidden', APPROVAL_ROLE_REFUSAL, headers);

  const result = await approveFloProposal(
    { tenantId: org.tenantId, userId: caller.user.id, role: org.role },
    proposalId.toLowerCase(),
    parsed.data.wersja,
    { editedBody: parsed.data.tresc },
    { onlyKind: 'payment.chase' },
  );
  if (!result.ok) {
    // Telefon nie ma Flo (plan D13): zdanie wykonawcy w pierwszej osobie zamieniamy na to, co zrobić.
    const message = result.message === EXECUTION_FAILED_MESSAGE ? REMINDER_DISPATCH_FAILED : result.message;
    return mobileError(422, 'reminder_refused', message, headers);
  }
  const odpowiedz: ZatwierdzeniePrzypomnieniaOdpowiedz = { zlecone: true };
  return mobileJson(odpowiedz, 200, headers);
}

const wstrzymanieSchema = z.object({ wstrzymane: z.boolean() }).strict();

/** `POST /api/mobile/v1/faktury/{id}/wstrzymanie`. */
export async function pauseRemindersFromMobile(caller: MobileCaller, invoiceId: string, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(invoiceId)) return mobileError(404, 'not_found', NOT_FOUND, headers);
  const raw = await body(request, caller);
  if (!raw.ok) return raw.response;
  const parsed = wstrzymanieSchema.safeParse(raw.value);
  if (!parsed.success) return badShape(caller);
  const result = await setInvoiceRemindersPaused(caller.db, invoiceId.toLowerCase(), parsed.data.wstrzymane);
  if (!result.success) return mobileError(422, 'reminder_refused', result.error ?? 'Nie udało się zmienić stanu przypomnień. Spróbuj ponownie.', headers);
  const odpowiedz: WstrzymanieOdpowiedz = { wstrzymane: parsed.data.wstrzymane };
  return mobileJson(odpowiedz, 200, headers);
}

// ─── PDF ──────────────────────────────────────────────────────────────

/**
 * `GET /api/mobile/v1/faktury/{id}/pdf`: ten sam PDF co `/api/invoices/{id}/pdf`.
 * `generateInvoicePdf` czyta fakturę kluczem serwisowym, więc firma MUSI być ta
 * z bramki (członkostwo sprawdzone tokenem), jak `resolveApiUserAndActiveOrg` na stronie.
 */
export async function invoicePdfForMobile(caller: MobileCaller, invoiceId: string): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(invoiceId)) return mobileError(404, 'not_found', NOT_FOUND, headers);
  const org = orgOf(caller);
  const result = await generateInvoicePdf(invoiceId.toLowerCase(), org.tenantId);
  if (!result.success) {
    // Cudza faktura wygląda jak brak faktury: telefon nie dowiaduje się, że istnieje.
    if (result.code === 'NOT_FOUND' || result.code === 'FORBIDDEN') return mobileError(404, 'not_found', NOT_FOUND, headers);
    return mobileError(409, 'pdf_unavailable', result.error, headers);
  }
  const odpowiedz: PdfFakturyOdpowiedz = { nazwa: result.filename, pdfBase64: Buffer.from(result.pdf).toString('base64') };
  return mobileJson(odpowiedz, 200, headers);
}

// ─── Skrzynka KSeF ────────────────────────────────────────────────────

const STAN: Record<Awaited<ReturnType<typeof requestInboxCheck>>['status'], SprawdzenieSkrzynkiOdpowiedz['stan']> = {
  accepted: 'zlecone',
  in_flight: 'w_toku',
  too_soon: 'za_wczesnie',
  no_ksef: 'bez_ksef',
  error: 'blad',
};

/** `POST /api/mobile/v1/skrzynka/sprawdz`. */
export async function inboxCheckFromMobile(caller: MobileCaller): Promise<NextResponse> {
  const result = await requestInboxCheck(orgOf(caller).tenantId);
  const odpowiedz: SprawdzenieSkrzynkiOdpowiedz = { stan: STAN[result.status], komunikat: result.message, ponowZaSekund: result.retryAfterSeconds ?? null };
  return mobileJson(odpowiedz, 200, caller.headers);
}
