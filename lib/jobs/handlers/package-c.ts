/**
 * Paczka C (Etap 7.5): 7 jobów OCR / importy / eksporty.
 *
 * Runnery żyją w lib/jobs/runners/* (jedno źródło prawdy).
 *
 * Konfiguracja przeniesiona 1:1 z dawnych funkcji Inngest (etap 7):
 *   - retries: OCR 2, auto-kategoryzacja 2, bulk-import 1, walidacja
 *     kontrahentów 1, eksporty 2, co-pilot 2,
 *   - `concurrency: { limit: N }` (globalne) → `batchSize: N` — worker
 *     pobiera do N jobów naraz z tej kolejki,
 *   - `onFailure` → `onExhausted` (wspólne funkcje w plikach jobów):
 *     oznaczenie zadania jako nieudanego, żeby UI nie wisiało na
 *     „przetwarzanie".
 *
 * 8 → 7: Magiczny import z KSeF wycofany (decyzja Bartosza 22.10.2026) —
 * historię pobiera automatycznie `ksef.history-sync.tenant` (paczka D),
 * a kolejka `import.ksef-history.requested` jest w RETIRED_QUEUES.
 */

import { runAutoCategorizeInbox } from '../runners/auto-categorize-inbox';
import {
  onBulkImportExhausted,
  runBulkImportFile,
} from '../runners/bulk-import';
import { runBulkValidateContractors } from '../runners/bulk-validate-contractors';
import {
  runCoPilotMonthly,
  runCoPilotSendPackage,
} from '../runners/co-pilot-monthly';
import { onExportsGenerateExhausted, runExportsGenerate } from '../runners/exports-generate';
import {
  onProcessOcrExhausted,
  runProcessOcr,
} from '../runners/process-ocr';
import { registerJob, type JobContext } from '../registry';

// ── Cron: miesięczne paczki dla księgowego ──
registerJob<Record<string, never>>({
  queue: 'cron.co-pilot-monthly',
  maxRetries: 4, // default Inngest (job nie deklaruje własnego)
  handler: (_data, ctx: JobContext) => runCoPilotMonthly(ctx),
});

// ── OCR paragonów ──
registerJob<Parameters<typeof runProcessOcr>[0]>({
  queue: 'ocr.process-photo',
  maxRetries: 2,
  batchSize: 5,
  handler: (data, ctx) => runProcessOcr(data, ctx),
  onExhausted: onProcessOcrExhausted,
});

// ── Auto-kategoryzacja faktur ze skrzynki ──
// Myślnik, nie kropka: zdarzenie `inbox/invoice-received` (z invoiceId).
// Kropkowe `inbox/invoice.received` to powiadomienie bez invoiceId — nie
// ma odbiorcy (patrz EVENT_QUEUE_MAP).
registerJob<Parameters<typeof runAutoCategorizeInbox>[0]>({
  queue: 'inbox.invoice-received',
  maxRetries: 2,
  batchSize: 10,
  handler: (data, ctx) => runAutoCategorizeInbox(data, ctx),
});

// ── Import pliku (CSV/XML) ──
registerJob<Parameters<typeof runBulkImportFile>[0]>({
  queue: 'import.file.uploaded',
  maxRetries: 1,
  batchSize: 5,
  handler: (data, ctx) => runBulkImportFile(data, ctx),
  onExhausted: onBulkImportExhausted,
});

// ── Masowa walidacja kontrahentów (Biała Lista / VIES) ──
registerJob<Parameters<typeof runBulkValidateContractors>[0]>({
  queue: 'validation.bulk-contractors.requested',
  maxRetries: 1,
  batchSize: 3,
  handler: (data, ctx) => runBulkValidateContractors(data, ctx),
});

// ── Generowanie eksportów (JPK, KPiR, Optima) ──
registerJob<Parameters<typeof runExportsGenerate>[0]>({
  queue: 'exports.generate.requested',
  maxRetries: 2,
  batchSize: 5,
  handler: (data, ctx) => runExportsGenerate(data, ctx),
  onExhausted: onExportsGenerateExhausted,
});

// ── Wysyłka paczki do księgowego ──
registerJob<Parameters<typeof runCoPilotSendPackage>[0]>({
  queue: 'exports.co-pilot.send-package',
  maxRetries: 2,
  batchSize: 3,
  handler: (data, ctx) => runCoPilotSendPackage(data, ctx),
});
