import { notFound } from 'next/navigation';

import { amountDueOf } from '@/lib/invoices/amount-due';
import { parentsWithOpenCorrection } from '@/lib/invoices/correction-parents';
import { canCorrectInvoice } from '@/lib/invoices/list-row-facts';
import { canSetAsRecurring } from '@/lib/invoices/recurring/visibility';
import { KSEF_RESEND_SOURCE_COLUMNS, ksefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import { canManageKsefSend } from '@/lib/invoices/ksef-send-policy';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { describeDuplicateOriginal, parseDuplicateCheck } from '@/lib/ksef/duplicate-check';
import {
  duplicateDecisionOptions,
  duplicateMarker,
  importedOriginalProvenance,
  retiredDraftView,
  type DuplicateDecisionInvoiceRow,
  type DuplicateDecisionView,
  type RetiredDraftView,
} from '@/lib/ksef/duplicate-decision';
import { loadDuplicateDecisionFacts } from '@/lib/ksef/duplicate-decision-facts';
import { invoiceVerificationUrl, ksefEnvForQr, qrLabel } from '@/lib/ksef/qr-verification';
import { isTenantStoragePath } from '@/lib/storage/tenant-path';
import { createClient } from '@/lib/supabase/server';
import {
  InvoiceDetailView,
  type InvoiceDetailInitial,
  type InvoiceDetailLine,
} from '@/components/invoices/invoice-detail-view';

export const dynamic = 'force-dynamic';

/** Pozycje w jednej linii: baza w pamięci testów rozbiera zagnieżdżony select tylko z jednolinijkowego nawiasu. */
const LINE_COLUMNS = 'ordinal, name, unit, quantity, unit_price_net, vat_rate, net_amount, vat_amount, gross_amount';

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from('invoices')
    .select(
      `
      id,
      tenant_id,
      internal_number,
      invoice_type,
      ${KSEF_RESEND_SOURCE_COLUMNS},
      sale_date,
      direction,
      origin,
      ksef_status,
      ksef_number,
      ksef_accepted_at,
      xml_storage_path,
      net_total,
      vat_total,
      gross_total,
      currency,
      ksef_environment,
      paid_amount,
      stripe_invoice_id,
      offline_idempotency_key,
      offline_qr_offline,
      offline_qr_certyfikat,
      notes,
      last_error,
      last_error_code,
      last_error_field,
      last_error_suggestion,
      seller_data,
      buyer_nip,
      buyer_data,
      payment_data,
      invoice_line_items(${LINE_COLUMNS})
      `
    )
    .eq('id', id)
    .maybeSingle();

  if (!invoice) notFound();
  const env = configuredKsefEnvironment();

  const { data: upo } = await supabase
    .from('upo_receipts')
    .select('status')
    .eq('invoice_id', id)
    .maybeSingle();

  // Rola w firmie TEJ faktury (nie z ciasteczka aktywnej firmy): decyduje
  // o przyciskach po błędzie wysyłki (PR 3b, D4). Akcje sprawdzają rolę
  // ponownie po swojej stronie — tu tylko to, co pokazać.
  const { data: { user } } = await supabase.auth.getUser();
  const { data: membership } = user
    ? await supabase
        .from('memberships')
        .select('role')
        .eq('user_id', user.id)
        .eq('organization_id', invoice.tenant_id as string)
        .eq('status', 'active')
        .maybeSingle()
    : { data: null };

  const canManageSend = canManageKsefSend(membership?.role ?? null);
  const resendFacts = ksefResendFacts(invoice, env);
  const internalNumber = (invoice.internal_number as string | null) ?? null;

  // D-A4-1b-3 (00144, PR B 00148): KSeF ma już fakturę o tym numerze, a automat
  // nie rozstrzygnął — dane oryginału ze znacznika 440 i decyzja klienta; szkic
  // z wpisem `number_taken` jest wycofany (każdy rodzaj, decyzja 9). Fakty czyta
  // loader sesją (RLS), z wierszem faktury tej strony; błąd odczytu rzuca
  // (fail-closed — strona błędu z ponowieniem, nie panel bez danych).
  const awaitingDecision = invoice.ksef_status === 'failed' && invoice.last_error_code === 'KSEF_DUPLICATE_RECONCILE';
  const facts = awaitingDecision || invoice.ksef_status === 'draft'
    ? await loadDuplicateDecisionFacts(
        supabase,
        invoice.tenant_id as string,
        id,
        // Kolumny `DUPLICATE_DECISION_INVOICE_COLUMNS` są w odczycie wyżej; loader sprawdza każdą.
        invoice as unknown as DuplicateDecisionInvoiceRow,
        // PR C (4.9, INV-13): przy znaczniku `faktflow-original` blokadę SQL czyta SESJA klienta
        // (`ksef_duplicate_decision_blocker_for_session`) — strona nie dostaje klucza serwisowego,
        // nie czyta archiwum i nie alarmuje; podgląd pliku jest w `importGate.preview` na znaczniku.
        // Szkic wycofany (baner) blokady nie potrzebuje.
        awaitingDecision ? { sqlBlocker: 'session' } : undefined,
      )
    : null;

  const duplicateDecision: DuplicateDecisionView | null = awaitingDecision && facts
    ? duplicateDecisionOptions({ facts, actor: 'client', canManage: canManageSend, environment: env, now: new Date() })
    : null;
  const marker = awaitingDecision && facts ? duplicateMarker(facts.submissions) : null;
  const original = marker?.original_ksef_number
    ? describeDuplicateOriginal(internalNumber, marker.original_ksef_number, parseDuplicateCheck(marker.original_check))
    : null;
  // Odmowa decyzji ma własny tekst (nazywa dokument i wyjście); `reason` zostawia notatkę PR A.
  const duplicateOriginal = original && duplicateDecision?.kind === 'refused' && duplicateDecision.message
    ? { ...original, note: duplicateDecision.message }
    : original;
  const retiredDraft: RetiredDraftView | null = invoice.ksef_status === 'draft' && facts
    ? retiredDraftView({
        invoiceNumber: internalNumber,
        invoiceKind: (invoice.invoice_kind as string | null) ?? null,
        submissions: facts.submissions,
        kindHeld: resendFacts.kindHeld,
      })
    : null;

  const lines = ((invoice.invoice_line_items ?? []) as InvoiceDetailLine[])
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);

  // E3 / P4: pola pochodne dla układu Finory. Tylko liczby i flagi — treść
  // dokumentu (`fa3_data`) zostaje na serwerze.
  const currency = (invoice.currency as string | null)?.trim().toUpperCase() || 'PLN';
  const splitPayment = hasSplitPayment(invoice.fa3_data);
  const amountDue = amountDueOf({
    invoice_kind: invoice.invoice_kind,
    gross_total: invoice.gross_total,
    payment_data: invoice.payment_data,
  });
  const canCorrect = await loadCanCorrect(supabase, invoice, env);
  const qr = await loadQr(supabase, invoice);

  const initial: InvoiceDetailInitial = {
    id: invoice.id as string,
    internal_number: internalNumber,
    invoice_type: (invoice.invoice_type as string | null) ?? null,
    invoice_kind: (invoice.invoice_kind as string | null) ?? null,
    issue_date: (invoice.issue_date as string | null) ?? null,
    sale_date: (invoice.sale_date as string | null) ?? null,
    ksef_status: invoice.ksef_status as string,
    ksef_number: (invoice.ksef_number as string | null) ?? null,
    ksef_accepted_at: (invoice.ksef_accepted_at as string | null) ?? null,
    xml_storage_path: (invoice.xml_storage_path as string | null) ?? null,
    net_total: invoice.net_total as string | number | null,
    vat_total: invoice.vat_total as string | number | null,
    gross_total: invoice.gross_total as string | number | null,
    notes: (invoice.notes as string | null) ?? null,
    last_error: (invoice.last_error as string | null) ?? null,
    last_error_code: (invoice.last_error_code as string | null) ?? null,
    last_error_field: (invoice.last_error_field as string | null) ?? null,
    last_error_suggestion: (invoice.last_error_suggestion as string | null) ?? null,
    seller_data: invoice.seller_data,
    buyer_data: invoice.buyer_data,
    payment_data: invoice.payment_data ?? null,
    lines,
    currency,
    split_payment: splitPayment,
    amount_due: amountDue,
    can_correct: canCorrect,
    // N1: „Ustaw jako cykliczną” tylko dla faktury, którą przyjmie akcja tworzenia (te same warunki).
    can_set_recurring: canSetAsRecurring({
      direction: invoice.direction as string | null,
      origin: (invoice.origin as string | null) ?? null,
      invoice_kind: invoice.invoice_kind as string | null,
      invoice_type: invoice.invoice_type as string | null,
      ksef_status: invoice.ksef_status as string | null,
      currency: invoice.currency as string | null,
    }),
    qr,
    upo_status:
      upo?.status ??
      null,
    can_manage_send: canManageSend,
    // A4b PR2b: fakty ponowienia z kopii — dla każdego stanu (Realtime zmienia stan, nie fakty);
    // sama treść (fa3_data, special_data) nie trafia do komponentu klienckiego.
    ksef_resend_facts: resendFacts,
    ksef_environment_known: env !== null,
    ksef_duplicate_original: duplicateOriginal,
    // D-A4-1b-3 PR B: widoki liczone na serwerze — bez surowego `original_check`.
    ksef_duplicate_decision: duplicateDecision,
    ksef_retired_draft: retiredDraft,
    // D-A4-1b-3 PR C: panel odsyła do akcji środowisko, które zobaczył (INV-8); karta K — skąd faktura się wzięła (6.5).
    ksef_server_environment: env,
    ksef_imported_original: importedOriginalProvenance(invoice.fa3_data),
  };

  return <InvoiceDetailView key={initial.id} initial={initial} />;
}

/** MPP (P_18A) z adnotacji dokumentu — sama flaga, bez reszty `fa3_data`. */
function hasSplitPayment(fa3Data: unknown): boolean {
  if (!fa3Data || typeof fa3Data !== 'object' || Array.isArray(fa3Data)) return false;
  const annotations = (fa3Data as { annotations?: unknown }).annotations;
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return false;
  return (annotations as { splitPayment?: unknown }).splitPayment === 1;
}

type SessionClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Link „Korekta”: ten sam predykat co lista faktur (`canCorrectInvoice`, warunki
 * formularza korekty) plus K4 — korekta w toku blokuje kolejną. Korekty rodzica
 * czytamy dopiero, gdy faktura w ogóle może być rodzicem. Błąd odczytu chowa
 * link („nie wiem” to nie „brak korekty w toku”), ale nie wywraca podglądu:
 * akcję i tak sprawdza formularz korekty po swojej stronie.
 */
async function loadCanCorrect(
  supabase: SessionClient,
  invoice: { id: unknown; tenant_id: unknown; direction: unknown; ksef_status: unknown; invoice_kind: unknown; ksef_environment: unknown; ksef_number: unknown },
  env: ReturnType<typeof configuredKsefEnvironment>,
): Promise<boolean> {
  if (!env) return false;
  const row = {
    id: invoice.id as string,
    direction: (invoice.direction as string | null) ?? null,
    origin: null,
    ksef_status: (invoice.ksef_status as string | null) ?? null,
    ksef_environment: (invoice.ksef_environment as string | null) ?? null,
    invoice_kind: (invoice.invoice_kind as string | null) ?? null,
    invoice_type: null,
    currency: null,
    gross_total: null,
    paid_amount: null,
    payment_data: null,
    payment_due_date: null,
    payment_status: null,
    ksef_number: (invoice.ksef_number as string | null) ?? null,
  };
  if (!canCorrectInvoice(row, { environment: env, openCorrectionParents: new Set() })) return false;

  const { data, error } = await supabase
    .from('invoices')
    .select('parent_invoice_id, ksef_status')
    .eq('tenant_id', invoice.tenant_id as string)
    .eq('parent_invoice_id', row.id)
    .eq('invoice_kind', 'correction');
  if (error) return false;
  const open = parentsWithOpenCorrection(
    (data ?? []) as Array<{ parent_invoice_id: string | null; ksef_status: string | null }>,
  );
  return canCorrectInvoice(row, { environment: env, openCorrectionParents: open });
}

/**
 * Kod QR weryfikacji (KOD I) — ten sam link co na PDF (`lib/pdf/invoice-pdf.ts`):
 * NIP sprzedawcy, data wystawienia i SHA-256 pliku XML wysłanego do KSeF.
 * Skrót czytamy sesją (RLS `xml_documents_select_own_tenant`), po ścieżce
 * zapisanej przy fakturze, z filtrem firmy i faktury. Bez numeru KSeF, bez
 * pliku XML (import, skrzynka) albo ze skrótem, który nie jest SHA-256, nie
 * ma kodu (`null`) — to NIE jest KOD II (certyfikat Offline, `qr-codes.ts`).
 * Błąd odczytu też daje `null`, jak w generatorze PDF (`readXmlHash`): kod QR
 * jest dodatkiem do dokumentu, nie powodem, by podgląd faktury się nie otworzył.
 */
async function loadQr(
  supabase: SessionClient,
  invoice: {
    id: unknown; tenant_id: unknown; ksef_number: unknown; xml_storage_path: unknown; issue_date: unknown; seller_data: unknown;
  },
): Promise<InvoiceDetailInitial['qr']> {
  const ksefNumber = (invoice.ksef_number as string | null)?.trim() || null;
  const path = (invoice.xml_storage_path as string | null) ?? null;
  const tenantId = invoice.tenant_id as string;
  const issueDate = (invoice.issue_date as string | null) ?? null;
  if (!ksefNumber || !path || !issueDate || !isTenantStoragePath(path, tenantId)) return null;

  const { data, error } = await supabase
    .from('xml_documents')
    .select('sha256_hash')
    .eq('storage_path', path)
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoice.id as string)
    .maybeSingle();
  if (error) return null;

  const url = invoiceVerificationUrl({
    env: ksefEnvForQr(),
    sellerNip: (invoice.seller_data as { nip?: string | null } | null)?.nip ?? null,
    issueDate,
    sha256Hex: (data as { sha256_hash: string | null } | null)?.sha256_hash ?? null,
  });
  return url ? { url, label: qrLabel(ksefNumber) } : null;
}
