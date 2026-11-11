'use server';

import { revalidatePath } from 'next/cache';

import {
  ARCHIVE_FORBIDDEN_MESSAGE,
  createArchiveOrder,
  deletePendingOrder,
  readArchiveOrder,
} from '@/lib/archiwum/zlecenia';
import { archivePeriod, archivePlDate, archiveRequestSchema } from '@/lib/archiwum/okres';
import { logAudit } from '@/lib/audit/log';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { formatJobSendError } from '@/lib/jobs/error-message';
import { documentArchiveRequested } from '@/lib/jobs/events';
import { getSignedInvoiceUrl } from '@/lib/storage/r2';
import { isTenantStoragePath } from '@/lib/storage/tenant-path';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

/**
 * Archiwum dokumentów firmy i paczka na kontrolę (plan kompletnej aplikacji,
 * krok 6.4, część 1). Zlecić i pobrać może tylko właściciel albo
 * administrator firmy; każde zlecenie i pobranie ma wpis w `audit_logs`.
 * Limit (jedno zlecenie na 10 minut na firmę) i jedno aktywne zlecenie na
 * okres pilnuje baza (00178), akcja zamienia odmowę na komunikat.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Podpisany link żyje krótko; ważność paczki wyznacza `expires_at`. */
const LINK_SECONDS = 300;

type ActionResult<T> = ({ success: true } & T) | { success: false; error: string };

async function ownerOrAdmin() {
  try {
    return await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return null;
    throw e;
  }
}

export async function requestDocumentArchiveAction(input: {
  kind: string;
  from: string;
  to: string;
}): Promise<ActionResult<{ id: string }>> {
  const ctx = await ownerOrAdmin();
  if (!ctx) return { success: false, error: ARCHIVE_FORBIDDEN_MESSAGE };
  const { supabase, user, tenantId } = ctx;

  const parsed = archiveRequestSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: 'Wybierz rodzaj paczki i okres w pełnych miesiącach.' };
  const period = archivePeriod(parsed.data, todayInWarsaw());
  if ('error' in period) return { success: false, error: period.error };

  const created = await createArchiveOrder(supabase, tenantId, { kind: parsed.data.kind, ...period });
  if (!created.ok) return { success: false, error: created.message };

  try {
    await sendJobEvent(documentArchiveRequested.create({ archiveId: created.id }));
  } catch (e) {
    // Bez zadania zlecenie blokowałoby okres; RLS pozwala usunąć tylko 'pending'.
    await deletePendingOrder(supabase, tenantId, created.id);
    return { success: false, error: formatJobSendError(e) };
  }

  await logAudit({
    action: 'document_archive.requested',
    tenantId,
    userId: user.id,
    entityType: 'document_archive',
    entityId: created.id,
    metadata: { kind: parsed.data.kind, periodStart: period.periodStart, periodEnd: period.periodEnd },
  });
  revalidatePath('/settings');
  return { success: true, id: created.id };
}

export async function getDocumentArchiveLinkAction(archiveId: string): Promise<ActionResult<{ url: string }>> {
  const ctx = await ownerOrAdmin();
  if (!ctx) return { success: false, error: 'Paczkę pobierze właściciel albo administrator firmy.' };
  const { supabase, user, tenantId } = ctx;
  if (!UUID_RE.test(archiveId)) return { success: false, error: 'Nie znaleziono paczki.' };

  const order = await readArchiveOrder(supabase, tenantId, archiveId);
  if (!order) return { success: false, error: 'Nie znaleziono paczki.' };
  if (order.status !== 'completed' || !order.file_key || !order.expires_at) {
    return { success: false, error: 'Paczka nie jest jeszcze gotowa.' };
  }
  if (new Date(order.expires_at).getTime() <= Date.now()) {
    const day = new Date(order.expires_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
    return { success: false, error: `Link do tej paczki wygasł ${archivePlDate(day)}. Zleć paczkę ponownie.` };
  }
  if (!isTenantStoragePath(order.file_key, tenantId)) return { success: false, error: 'Nie znaleziono paczki.' };

  let url: string;
  try {
    url = await getSignedInvoiceUrl(order.file_key, tenantId, LINK_SECONDS);
  } catch {
    return { success: false, error: 'Nie udało się przygotować linku do pobrania. Spróbuj ponownie za chwilę.' };
  }
  await logAudit({
    action: 'document_archive.downloaded',
    tenantId,
    userId: user.id,
    entityType: 'document_archive',
    entityId: order.id,
    metadata: { kind: order.kind, periodStart: order.period_start, periodEnd: order.period_end },
  });
  return { success: true, url };
}
