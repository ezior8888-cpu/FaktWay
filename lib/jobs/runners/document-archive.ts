// lib/jobs/runners/document-archive.ts
// Archiwum dokumentów firmy i paczka na kontrolę (plan kompletnej aplikacji,
// krok 6.4, część 1; tabela `document_archives`, migracja 00178).
//
// Worker pg-boss ponawia CAŁY handler (bez pamięci kroków), więc każdy krok
// z efektem jest idempotentny w bazie albo u dostawcy:
//   1. stan `pending` → `generating` warunkiem na stan (zlecenie `failed`
//      albo `completed` nie składa się drugi raz);
//   2. ZIP pod stałym kluczem zlecenia z zapisem warunkowym (IfNoneMatch):
//      ponowienie po zapisie nie tworzy drugiego pliku, a liczby bierze
//      z metadanych obiektu, który już leży w magazynie;
//   3. `generating` → `completed` z wygaśnięciem linku, warunkiem na stan;
//   4. e-mail z kluczem idempotencji Resend `document-archive/<id>/ready`
//      i znacznik `notified_at` warunkiem `IS NULL`.

import type { SupabaseClient } from '@supabase/supabase-js';

import { NonRetriableError } from '../errors';
import type { JobContext } from '@/lib/jobs/registry';
import { documentArchiveRequested } from '@/lib/jobs/events';
import { ArchiveTooLargeError, buildArchivePackage } from '@/lib/archiwum/paczka';
import { ARCHIVE_KIND_LABELS, ARCHIVE_LINK_DAYS, archivePeriodLabel, archivePlDate, type ArchiveKind } from '@/lib/archiwum/okres';
import { sendEmail } from '@/lib/email/send';
import { statR2Object, uploadToR2IfAbsent } from '@/lib/storage/r2';
import { createAdminClient } from '@/lib/supabase/admin';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const GENERIC_FAILURE = 'Nie udało się przygotować paczki. Zleć ją ponownie albo napisz do nas.';

interface OrderRow {
  id: string;
  tenant_id: string;
  kind: ArchiveKind;
  period_start: string;
  period_end: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  requested_by: string | null;
  missing_count: number | null;
  expires_at: string | null;
  notified_at: string | null;
}

const ORDER_COLUMNS = 'id, tenant_id, kind, period_start, period_end, status, requested_by, missing_count, expires_at, notified_at';

/** Klucz pliku w magazynie: katalog firmy i zlecenia (CHECK `document_archives_file_key_check`). */
export function archiveFileKey(tenantId: string, archiveId: string, fileName: string): string {
  return `exports/${tenantId}/archiwum/${archiveId}/${fileName}`;
}

function db(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
}

async function readOrder(client: SupabaseClient, archiveId: string): Promise<OrderRow> {
  const { data, error } = await client.from('document_archives').select(ORDER_COLUMNS).eq('id', archiveId).maybeSingle();
  if (error) throw new Error(`document_archives: ${error.message}`);
  if (!data) throw new NonRetriableError(`Zlecenie archiwum ${archiveId} nie istnieje`);
  return data as unknown as OrderRow;
}

function count(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function notifyReady(client: SupabaseClient, order: OrderRow): Promise<void> {
  let email: string | null = null;
  if (order.requested_by) {
    const { data, error } = await client.auth.admin.getUserById(order.requested_by);
    if (error && error.status !== 404) throw new Error(`auth.users: ${error.message}`);
    email = data?.user?.email ?? null;
  }
  if (email) {
    const what = `${ARCHIVE_KIND_LABELS[order.kind]} (${archivePeriodLabel(order.period_start, order.period_end)})`;
    const until = order.expires_at ? archivePlDate(new Date(order.expires_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' })) : '';
    const gaps = order.missing_count
      ? `<p>Część plików nie trafiła do paczki (${order.missing_count}). Powody i to, co z nimi zrobić, są w pliku CO-JEST-W-PACZCE.txt.</p>`
      : '';
    await sendEmail({
      to: email,
      subject: 'Paczka dokumentów w FaktWay jest gotowa',
      html:
        `<p>${escapeHtml(what)} jest gotowa do pobrania.</p>` +
        `<p>Pobierzesz ją w FaktWay: Ustawienia, Firma, Archiwum dokumentów. Link działa do ${escapeHtml(until)}.</p>` +
        gaps +
        `<p><a href="${escapeHtml(`${APP_URL}/settings#archiwum`)}">Otwórz ustawienia firmy</a></p>`,
      userId: order.requested_by ?? undefined,
      idempotencyKey: `document-archive/${order.id}/ready`,
    });
  }
  const { error } = await client
    .from('document_archives')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', order.id)
    .is('notified_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`document_archives: ${error.message}`);
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-c.ts (kolejka archive.document.requested).
 */
export async function runDocumentArchive(eventData: { archiveId: string }, { logger }: JobContext) {
  const parsed = documentArchiveRequested.safeParse(eventData);
  if (!parsed.success) throw new NonRetriableError('Zły identyfikator zlecenia archiwum');
  const { archiveId } = parsed.data;
  const client = db();
  let order = await readOrder(client, archiveId);

  if (order.status === 'failed') {
    // Zamknięte jako utknięte albo po wyczerpaniu prób: nowe zlecenie zakłada klient.
    logger.info('Zlecenie archiwum zamknięte, bez składania', { archiveId });
    return { skipped: 'failed' as const };
  }

  if (order.status !== 'completed') {
    const { data: claimed, error: claimError } = await client
      .from('document_archives')
      .update({ status: 'generating', started_at: new Date().toISOString() })
      .eq('id', archiveId)
      .in('status', ['pending', 'generating'])
      .select('id')
      .maybeSingle();
    if (claimError) throw new Error(`document_archives: ${claimError.message}`);
    // Stan zmienił się między odczytem a zajęciem: ponowienie przeczyta go od nowa.
    if (!claimed) throw new Error('Zlecenie archiwum zmieniło stan, ponawiam');

    let built: Awaited<ReturnType<typeof buildArchivePackage>>;
    try {
      built = await buildArchivePackage({
        id: order.id,
        tenantId: order.tenant_id,
        kind: order.kind,
        periodStart: order.period_start,
        periodEnd: order.period_end,
      });
    } catch (error) {
      if (error instanceof ArchiveTooLargeError) throw new NonRetriableError(error.message);
      throw error;
    }

    const key = archiveFileKey(order.tenant_id, order.id, built.fileName);
    const uploaded = await uploadToR2IfAbsent(key, built.zip, 'application/zip', {
      'files-count': String(built.filesCount),
      'missing-count': String(built.missing.length),
    });
    // Plik z wcześniejszej próby zostaje; wiersz opisuje ten, który leży w magazynie.
    const stored = uploaded ? null : await statR2Object(key, order.tenant_id);
    if (!uploaded && !stored) throw new Error('Plik archiwum zniknął między zapisem a odczytem, ponawiam');
    const finishedAt = new Date();
    const expiresAt = new Date(finishedAt.getTime() + ARCHIVE_LINK_DAYS * 24 * 3600 * 1000);
    const { data: done, error: doneError } = await client
      .from('document_archives')
      .update({
        status: 'completed',
        file_key: key,
        file_name: built.fileName,
        size_bytes: stored ? stored.sizeBytes : built.zip.length,
        files_count: stored ? count(stored.metadata['files-count'], built.filesCount) : built.filesCount,
        missing_count: stored ? count(stored.metadata['missing-count'], built.missing.length) : built.missing.length,
        finished_at: finishedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        error_message: null,
      })
      .eq('id', archiveId)
      .eq('status', 'generating')
      .select(ORDER_COLUMNS)
      .maybeSingle();
    if (doneError) throw new Error(`document_archives: ${doneError.message}`);
    if (!done) throw new Error('Zlecenie archiwum zmieniło stan przed gotowością, ponawiam');
    order = done as unknown as OrderRow;
    logger.info('Archiwum gotowe', { archiveId, files: built.filesCount, missing: built.missing.length, reused: !uploaded });
  }

  if (!order.notified_at) await notifyReady(client, order);
  return { success: true as const };
}

/**
 * Po wyczerpaniu prób albo odmowie: zlecenie „nieudane” z powodem dla
 * człowieka, tylko z aktywnego stanu (gotowej paczki błąd poczty nie psuje).
 */
export async function onDocumentArchiveExhausted(failure: Error, data: { archiveId: string }): Promise<void> {
  const message = failure.message === new ArchiveTooLargeError().message ? failure.message : GENERIC_FAILURE;
  const { error } = await db()
    .from('document_archives')
    .update({ status: 'failed', error_message: message, finished_at: new Date().toISOString() })
    .eq('id', data.archiveId)
    .in('status', ['pending', 'generating'])
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
}
