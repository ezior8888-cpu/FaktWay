import 'server-only';

import { revalidatePath } from 'next/cache';

import { sendJobEvent } from '@/lib/jobs/enqueue';
import { formatJobSendError } from '@/lib/jobs/error-message';
import { ocrProcessPhotoRequested } from '@/lib/jobs/events';
import { deleteExpensePhoto, detectExpensePhotoType, uploadExpensePhoto } from '@/lib/storage/expenses';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  formatUploadSize,
  UPLOAD_FILE_LIMIT_BYTES,
  UPLOAD_FILE_LIMIT_LABEL,
  UPLOAD_IMAGE_LIMIT_BYTES,
  UPLOAD_IMAGE_LIMIT_LABEL,
} from '@/lib/upload-limit';

/**
 * Przyjęcie dokumentu kosztu (zdjęcie albo PDF) i zlecenie odczytu (OCR).
 * Do sesji 31 planu skalowania to było ciało `uploadExpensePhotoAction`;
 * teraz wołają je trasy `/api/uploads/expense` i `/share-target` po bramce
 * z `lib/uploads/server.ts`, która sprawdziła sesję, 2FA i członkostwo
 * w firmie `tenantId`.
 *
 * NIE eksportuj tego z pliku `'use server'`: każdy taki eksport to publiczna
 * końcówka, a ta funkcja bierze `tenantId` z argumentu.
 *
 * Limit zależy od typu z zawartości (AUD-105): zdjęcie do 7 MB (próg odczytu
 * OCR), PDF do 10 MB. Typ czytamy z pierwszych bajtów, zanim cały plik trafi
 * do bufora.
 *
 * Od M9 planu aplikacji mobilnej woła je też `POST /api/mobile/v1/wydatki/zdjecie`
 * (`lib/api/mobile/wydatki.ts`) z `onJobCreated`: klucz idempotencji telefonu
 * powstaje zaraz po zadaniu OCR, zanim plik trafi do magazynu, a odczyt do
 * kolejki. Odmowa klucza (np. równoległe ponowienie zdążyło pierwsze) kończy
 * wgranie bez pliku i bez odczytu, a zadanie znika. Strona go nie podaje.
 */

export type ExpenseDocumentKind = 'zdjecie' | 'pdf';

export type ExpenseUploadOutcome =
  | { success: true; ocrJobId: string }
  | {
      success: false;
      error: string;
      /** Kod HTTP dla trasy JSON. */
      status: number;
      /** Plik ponad limit swojego typu — `/share-target` pokazuje wtedy komunikat na Kosztach. */
      tooLarge?: { kind: ExpenseDocumentKind; size: number };
    };

/** Tyle bajtów wystarcza `detectExpensePhotoType` (najdłuższa sygnatura: WEBP, 12 B). */
const SIGNATURE_BYTES = 16;

export function expenseTooLargeMessage(kind: ExpenseDocumentKind, size: number): string {
  const label = formatUploadSize(size);
  return kind === 'pdf'
    ? `PDF ma ${label}, a można wgrać najwyżej ${UPLOAD_FILE_LIMIT_LABEL}. Zapisz go w niższej rozdzielczości albo podziel na mniejsze pliki.`
    : `Zdjęcie ma ${label}, a do odczytu można wgrać najwyżej ${UPLOAD_IMAGE_LIMIT_LABEL}. Zrób zdjęcie w niższej rozdzielczości albo zapisz je jako mniejszy JPG.`;
}

/** Odmowa `onJobCreated`: kod HTTP i komunikat dla klienta. */
export type JobCreatedRefusal = { ok: false; status: number; error: string };

export async function acceptExpenseDocument({
  userId,
  tenantId,
  file,
  onJobCreated,
}: {
  userId: string;
  tenantId: string;
  file: File;
  /** Krok po zapisie zadania OCR, przed magazynem i kolejką (telefon: klucz idempotencji). */
  onJobCreated?: (ocrJobId: string) => Promise<{ ok: true } | JobCreatedRefusal>;
}): Promise<ExpenseUploadOutcome> {
  // Typ z zawartości, nie z nagłówka przeglądarki (AUD-105).
  const mimeType = detectExpensePhotoType(new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer()));
  if (!mimeType) {
    return {
      success: false,
      status: 400,
      error: 'Nieobsługiwany format pliku. Wgraj zdjęcie (JPG, PNG, WEBP, GIF) albo PDF.',
    };
  }

  const kind: ExpenseDocumentKind = mimeType === 'application/pdf' ? 'pdf' : 'zdjecie';
  const limit = kind === 'pdf' ? UPLOAD_FILE_LIMIT_BYTES : UPLOAD_IMAGE_LIMIT_BYTES;
  if (file.size > limit) {
    return {
      success: false,
      status: 413,
      error: expenseTooLargeMessage(kind, file.size),
      tooLarge: { kind, size: file.size },
    };
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Ten job zapisujemy admin clientem (omija RLS), więc tenant MUSI być
  // zweryfikowany przez membership — robi to bramka trasy
  // (`requireUserAndActiveOrg`), nie format cookie.
  const admin = createAdminClient();
  const { data: ocrJob, error: jobError } = await admin
    .from('ocr_jobs')
    .insert({
      tenant_id: tenantId,
      created_by: userId,
      status: 'pending',
      source_file_path: 'pending',
      source_file_mime: mimeType,
      source_file_size_bytes: file.size,
    })
    .select('id')
    .single();

  if (jobError || !ocrJob) {
    return { success: false, status: 500, error: 'Błąd zapisu joba' };
  }

  if (onJobCreated) {
    let claimed: { ok: true } | JobCreatedRefusal;
    try {
      claimed = await onJobCreated(ocrJob.id);
    } catch {
      claimed = { ok: false, status: 500, error: 'Błąd zapisu joba' };
    }
    if (!claimed.ok) {
      // Bez pliku i bez zdarzenia: zadanie nie da wydatku, więc znika.
      await admin.from('ocr_jobs').delete().eq('id', ocrJob.id);
      return { success: false, status: claimed.status, error: claimed.error };
    }
  }

  let r2Key: string | null = null;

  try {
    r2Key = await uploadExpensePhoto(tenantId, ocrJob.id, buffer, mimeType);

    const { error: pathErr } = await admin
      .from('ocr_jobs')
      .update({ source_file_path: r2Key })
      .eq('id', ocrJob.id);

    if (pathErr) {
      await deleteExpensePhoto(r2Key);
      await admin.from('ocr_jobs').delete().eq('id', ocrJob.id);
      return { success: false, status: 500, error: pathErr.message };
    }

    await sendJobEvent(
      ocrProcessPhotoRequested.create({
        ocrJobId: ocrJob.id,
        tenantId,
      }),
    );
  } catch (e) {
    if (r2Key) {
      try {
        await deleteExpensePhoto(r2Key);
      } catch {
        // best-effort — nie blokuj zwrotki
      }
    }
    await admin.from('ocr_jobs').delete().eq('id', ocrJob.id);
    return {
      success: false,
      status: 500,
      error: formatJobSendError(e),
    };
  }

  revalidatePath('/expenses');
  return { success: true, ocrJobId: ocrJob.id };
}
