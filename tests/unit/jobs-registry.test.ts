/**
 * Testy rejestru handlerów (Etap 7, paczki A-B).
 *
 * Cel: wyłapać rozjazd między zarejestrowanymi kolejkami a mapą
 * `lib/jobs/queues.ts` ZANIM worker wystartuje na produkcji — literówka
 * w nazwie kolejki oznaczałaby cicho nieobsługiwany job.
 */

import { describe, expect, it } from 'vitest';

import { allEventQueues, CRON_JOBS } from '@/lib/jobs/queues';
import { getRegisteredJobs } from '@/lib/jobs/registry';

// Side-effect: rejestracje paczek.
import '@/lib/jobs/handlers/package-a';
import '@/lib/jobs/handlers/package-b';
import '@/lib/jobs/handlers/package-c';
import '@/lib/jobs/handlers/package-d';

const registered = getRegisteredJobs();
const queues = registered.map((j) => j.queue);

describe('rejestr jobów', () => {
  it('nie ma duplikatów kolejek', () => {
    expect(new Set(queues).size).toBe(queues.length);
  });

  it('każda zarejestrowana kolejka istnieje w queues.ts', () => {
    const known = new Set<string>([
      ...CRON_JOBS.map((c) => c.queue),
      ...allEventQueues(),
    ]);
    const unknown = queues.filter((q) => !known.has(q));
    expect(unknown, 'kolejki spoza queues.ts (literówka?)').toEqual([]);
  });

  it('każda kolejka zdarzeń ma handlera', () => {
    // Kierunek odwrotny do testu wyżej. Literówka trafiająca w INNĄ istniejącą
    // kolejkę przechodzi tamten test, a zostawia własną bez konsumenta — worker
    // jej nie tworzy, więc `boss.send` rzuca „Queue … does not exist”.
    // Tak auto-kategoryzacja skrzynki słuchała `inbox.invoice.received`
    // zamiast `inbox.invoice-received` od 17.08 do 25.09.2026.
    const bezHandlera = allEventQueues().filter((q) => !queues.includes(q));
    expect(bezHandlera, 'kolejki zdarzeń bez zarejestrowanego joba').toEqual([]);
  });

  it('paczka A: 14 cronów utrzymaniowych (bez odświeżania widoków, AUD-118; + cykl życia, PR 4b; + retencja czatu)', () => {
    const packageA = [
      'cron.archive-old-invoices',
      'cron.cert-expiry-alert',
      'cron.cleanup-audit-logs',
      'cron.cleanup-old-backups',
      'cron.daily-db-snapshot',
      'cron.gdpr-process-deletions',
      'cron.jobs-watchdog',
      'cron.ksef-health-check',
      'cron.ksef-lifecycle-reconcile',
      'cron.ksef-lifecycle-report',
      'cron.nightly-validation-recheck',
      'cron.retention-delete',
      'cron.support-chat-retention',
      'cron.verify-backup',
    ];
    expect(packageA.length).toBe(14);
    for (const q of packageA) expect(queues, `brak ${q}`).toContain(q);
  });

  it('paczka B: 17 jobów e-mail/billing/przypomnienia', () => {
    const packageB = [
      'cron.critical-alerts-monitor',
      'cron.daily-analytics-digest',
      'cron.daily-summary-email',
      'cron.reminder-scheduler',
      'cron.trial-countdown-emails',
      'cron.weekly-business-review',
      'invoice.submit.succeeded.notify',
      'invoice.submit.failed.notify',
      'billing.payment.failed',
      'reminders.send.requested',
      'invoice.payment.received',
      'user.registered',
      'email.trial-day-1',
      'email.trial-day-4',
      'email.trial-day-8',
      'email.trial-day-12',
      'email.trial-day-14',
    ];
    expect(packageB.length).toBe(17);
    for (const q of packageB) expect(queues, `brak ${q}`).toContain(q);
  });

  it('parytet retries z konfiguracją Inngest (kluczowe joby)', () => {
    const byQueue = new Map(registered.map((j) => [j.queue, j]));
    // Powiadomienia i sekwencja: 2 (lepiej nie wysłać niż wysłać 4×).
    expect(byQueue.get('invoice.submit.succeeded.notify')?.maxRetries).toBe(2);
    expect(byQueue.get('user.registered')?.maxRetries).toBe(2);
    // Billing/przypomnienia: 3.
    expect(byQueue.get('billing.payment.failed')?.maxRetries).toBe(3);
    expect(byQueue.get('reminders.send.requested')?.maxRetries).toBe(3);
    // Nightly validation: 1 (jak w Inngest).
    expect(byQueue.get('cron.nightly-validation-recheck')?.maxRetries).toBe(1);
    // Sprzątanie dzienników paczkami (00157): ponowienie od zera powtarza 10-min budżet,
    // więc 1 (błąd przejściowy); resztę i tak bierze następna noc.
    expect(byQueue.get('cron.cleanup-audit-logs')?.maxRetries).toBe(1);
    // Reszta: default Inngest 4.
    expect(byQueue.get('cron.daily-summary-email')?.maxRetries).toBe(4);
  });

  it('dunning ma limit równoległości per tenant (grupa pg-boss)', () => {
    const dunning = registered.find((j) => j.queue === 'billing.payment.failed');
    expect(dunning?.groupConcurrency).toBe(1);
  });

  it('paczka C: 7 jobów OCR/importy/eksporty (bez Magicznego importu — decyzja Bartosza 22.10.2026)', () => {
    const packageC = [
      'cron.co-pilot-monthly',
      'ocr.process-photo',
      'inbox.invoice-received',
      'import.file.uploaded',
      'validation.bulk-contractors.requested',
      'exports.generate.requested',
      'exports.co-pilot.send-package',
    ];
    expect(packageC.length).toBe(7);
    for (const q of packageC) expect(queues, `brak ${q}`).toContain(q);
    // 8 → 7: Magiczny import wycofany — kolejka w RETIRED_QUEUES, bez workera.
    expect(queues).not.toContain('import.ksef-history.requested');
  });

  it('joby z onFailure w Inngest mają odpowiednik onExhausted', () => {
    // Bez tego pasek postępu w UI wisiałby po nieudanym imporcie/OCR.
    const withHandler = [
      'ocr.process-photo',
      'import.file.uploaded',
    ];
    const byQueue = new Map(registered.map((j) => [j.queue, j]));
    for (const q of withHandler) {
      expect(typeof byQueue.get(q)?.onExhausted, `brak onExhausted: ${q}`).toBe(
        'function',
      );
    }
  });

  it('paczka D: 12 jobów rdzenia KSeF (9 z Inngest + cron uzupełniający skrzynkę, K2, + historia KSeF)', () => {
    const packageD = [
      'invoice.submit.requested',
      'invoice.upo.requested',
      'cron.upo-retry-stale',
      'cron.inbox-polling',
      'inbox.poll.tenant',
      'cron.inbox-backfill',
      'cron.process-offline-queue',
      'invoice.submit.succeeded.offline-queue',
      'invoice.submit.failed.offline-queue',
      'billing.payment.succeeded',
      // 10 → 12: synchronizacja historii KSeF (decyzja Bartosza 22.10.2026).
      'cron.ksef-history-sync',
      'ksef.history-sync.tenant',
    ];
    expect(packageD.length).toBe(12);
    for (const q of packageD) expect(queues, `brak ${q}`).toContain(q);
  });

  it('submit-invoice: PEŁNY harmonogram KSeF 30s→2m→5m→15m→1h w rejestrze', () => {
    // Serce produktu. Zły harmonogram = zalewanie API Ministerstwa albo
    // faktury wiszące bez ponowienia.
    const submit = registered.find((j) => j.queue === 'invoice.submit.requested');
    expect(submit?.maxRetries).toBe(5);
    expect(typeof submit?.onExhausted, 'brak ścieżki Offline24').toBe('function');

    const expected = [30_000, 120_000, 300_000, 900_000, 3_600_000];
    for (let attempt = 0; attempt < expected.length; attempt++) {
      expect(submit?.getDelayMs?.(attempt), `próba ${attempt}`).toBe(
        expected[attempt],
      );
    }
  });

  it('limity per tenant/NIP w rdzeniu KSeF', () => {
    const byQueue = new Map(registered.map((j) => [j.queue, j]));
    expect(byQueue.get('invoice.submit.requested')?.groupConcurrency).toBe(100);
    expect(byQueue.get('invoice.upo.requested')?.groupConcurrency).toBe(3);
    expect(byQueue.get('inbox.poll.tenant')?.groupConcurrency).toBe(1); // AUD-91: jeden przebieg skrzynki na NIP
    expect(byQueue.get('billing.payment.succeeded')?.groupConcurrency).toBe(1);
    // Historia KSeF: jeden przebieg na NIP, bez ponowień pg-boss (ponowieniem
    // jest następny cron — cały stan w bazie), 3 firmy naraz (plan fan-outu).
    expect(byQueue.get('ksef.history-sync.tenant')?.groupConcurrency).toBe(1);
    expect(byQueue.get('ksef.history-sync.tenant')?.maxRetries).toBe(0);
    expect(byQueue.get('ksef.history-sync.tenant')?.localConcurrency).toBe(3);
  });

  it('KOMPLET: 50 jobów (45 z inwentaryzacji + skrzynka + 2 crony cyklu życia + retencja czatu + historia KSeF − Magiczny import)', () => {
    // Alarm, gdyby któraś paczka wypadła z importów workera.
    // 45: od AUD-118 bez crona odświeżania widoków zmaterializowanych;
    // 46: od K2 (03.10.2026) z `cron.inbox-backfill`;
    // 48: od PR 4b cyklu życia (03.10.2026) z `cron.ksef-lifecycle-reconcile`
    // i `cron.ksef-lifecycle-report`;
    // 49: od 15.10.2026 z `cron.support-chat-retention` (retencja czatu pomocy
    // z polityki prywatności);
    // 50: od 22.10.2026 (decyzja Bartosza) — +2 historia KSeF
    // (`cron.ksef-history-sync`, `ksef.history-sync.tenant`), −1 Magiczny import
    // (`import.ksef-history.requested`). Worker: 54 kolejki, „29/29 cronów”.
    expect(registered.length).toBe(50);
  });

  it('parytet limitów równoległości paczki C', () => {
    const byQueue = new Map(registered.map((j) => [j.queue, j]));
    expect(byQueue.get('ocr.process-photo')?.batchSize).toBe(5);
    expect(byQueue.get('inbox.invoice-received')?.batchSize).toBe(10);
    expect(byQueue.get('validation.bulk-contractors.requested')?.batchSize).toBe(3);
  });
});
