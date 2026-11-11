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
import '@/lib/jobs/handlers/webhooks';
import '@/lib/jobs/handlers/app-notifications';

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

  it('paczka A: 15 cronów utrzymaniowych (bez odświeżania widoków, AUD-118; + cykl życia, PR 4b; + retencja czatu; + pliki paczek archiwum)', () => {
    const packageA = [
      'cron.archive-old-invoices',
      'cron.cert-expiry-alert',
      'cron.cleanup-audit-logs',
      'cron.cleanup-old-backups',
      'cron.daily-db-snapshot',
      // 14 → 15 (11.11.2026, plan kompletnej aplikacji, krok 6.4, część 2): usuwanie
      // z magazynu plików paczek archiwum po wygaśnięciu linku (00190), raz na dobę.
      'cron.document-archive-cleanup',
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
    expect(packageA.length).toBe(15);
    for (const q of packageA) expect(queues, `brak ${q}`).toContain(q);
  });

  it('paczka B: 20 jobów e-mail/billing/przypomnienia', () => {
    const packageB = [
      'cron.critical-alerts-monitor',
      'cron.ksiegowosc-miesiac',
      'cron.ksiegowosc-terminy',
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
      // 19 → 20: mail o logowaniu z nowego urządzenia (krok 8.5, część 2).
      'auth.login.completed',
      'user.registered',
      'email.trial-day-1',
      'email.trial-day-4',
      'email.trial-day-8',
      'email.trial-day-12',
      'email.trial-day-14',
    ];
    expect(packageB.length).toBe(20);
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
    // Pliki paczek archiwum (00190): przebieg idempotentny, ponowienie po błędzie magazynu
    // bierze tylko pliki bez znacznika, więc domyślne 4 próby.
    expect(byQueue.get('cron.document-archive-cleanup')?.maxRetries).toBe(4);
  });

  it('dunning ma limit równoległości per tenant (grupa pg-boss)', () => {
    const dunning = registered.find((j) => j.queue === 'billing.payment.failed');
    expect(dunning?.groupConcurrency).toBe(1);
  });

  it('paczka C: 8 jobów OCR/importy/eksporty/archiwum (bez Magicznego importu — decyzja Bartosza 22.10.2026)', () => {
    const packageC = [
      'cron.co-pilot-monthly',
      'ocr.process-photo',
      'inbox.invoice-received',
      'import.file.uploaded',
      'validation.bulk-contractors.requested',
      'exports.generate.requested',
      'exports.co-pilot.send-package',
      // 7 → 8 (09.11.2026, plan kompletnej aplikacji, krok 6.4): archiwum
      // dokumentów firmy i paczka na kontrolę (00178), jedno naraz w procesie.
      'archive.document.requested',
    ];
    expect(packageC.length).toBe(8);
    for (const q of packageC) expect(queues, `brak ${q}`).toContain(q);
    // 8 → 7: Magiczny import wycofany — kolejka w RETIRED_QUEUES, bez workera.
    expect(queues).not.toContain('import.ksef-history.requested');
  });

  it('joby z onFailure w Inngest mają odpowiednik onExhausted', () => {
    // Bez tego pasek postępu w UI wisiałby po nieudanym imporcie/OCR.
    const withHandler = [
      'ocr.process-photo',
      'import.file.uploaded',
      // Bez tego zlecenie archiwum wisiałoby „w przygotowaniu” po wyczerpaniu prób.
      'archive.document.requested',
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
    // L1a (08.11.2026): MF liczy limity na parę (NIP, IP), a cała platforma
    // wysyła z jednego adresu — firma ma najwyżej 2 wysyłki naraz (wcześniej
    // 100, czyli bez limitu: jedna firma zajmowała wszystkie sloty).
    expect(byQueue.get('invoice.submit.requested')?.groupConcurrency).toBe(2);
    expect(byQueue.get('invoice.upo.requested')?.groupConcurrency).toBe(3);
    expect(byQueue.get('inbox.poll.tenant')?.groupConcurrency).toBe(1); // AUD-91: jeden przebieg skrzynki na NIP
    // Harmonogram 00160: ponowieniem przebiegu jest termin zależny od rodzaju błędu,
    // a taktu rozsyłki następna minuta. Sloty z konfiguracji, domyślnie 16.
    expect(byQueue.get('inbox.poll.tenant')?.maxRetries).toBe(0);
    expect(byQueue.get('inbox.poll.tenant')?.localConcurrency).toBe(16);
    expect(byQueue.get('cron.inbox-polling')?.maxRetries).toBe(0);
    expect(byQueue.get('billing.payment.succeeded')?.groupConcurrency).toBe(1);
    // Historia KSeF: jeden przebieg na NIP, bez ponowień pg-boss (ponowieniem
    // jest następny cron — cały stan w bazie), 3 firmy naraz (plan fan-outu).
    expect(byQueue.get('ksef.history-sync.tenant')?.groupConcurrency).toBe(1);
    expect(byQueue.get('ksef.history-sync.tenant')?.maxRetries).toBe(0);
    expect(byQueue.get('ksef.history-sync.tenant')?.localConcurrency).toBe(3);
  });

  it('KOMPLET: 61 jobów (45 z inwentaryzacji + skrzynka + 2 crony cyklu życia + retencja czatu + historia KSeF − Magiczny import + 2 crony księgowości + mail o nowym urządzeniu + archiwum dokumentów + 3 kolejki dzwonka + sprzątanie plików archiwum)', () => {
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
    // 52: od K5 księgowości (07.11.2026) — +2 crony `cron.ksiegowosc-miesiac`
    // i `cron.ksiegowosc-terminy` (pętla po firmach pilotażu, bez kolejki
    // fan-out; plan, sekcja 9). Worker: 56 kolejek, „31/31 cronów”.
    // 53: od kroku 8.5 część 2 — +1 `auth.login.completed` (mail o nowym urządzeniu).
    // 54: od 09.11.2026 (plan kompletnej aplikacji, krok 6.4) z kolejką
    // `archive.document.requested` (archiwum dokumentów, 00178). Worker: 57 kolejek.
    // 57: od webhooków (suma z 53-54: 52 + 2 + 3) publicznego API (krok 7.1, część 3, 00187) — +3:
    // `webhooks.event.emitted` (zdarzenie → dostawy), `invoice.submit.succeeded.webhook`
    // (trzecia kolejka zdarzenia „faktura przyjęta w KSeF”) i cron
    // `cron.webhooks-deliver` (ponowienia, co minutę; przy wyłączonej fladze
    // `publicApiEnabled` kończy się bez zapytań). Worker: 60 kolejek (57 + 3), „32/32 cronów”.
    // 59: od dzwonka w aplikacji (plan kompletnej aplikacji, krok 8.1, część 2,
    // 00188) — +2 kolejki zdarzeń wyniku wysyłki do KSeF:
    // `invoice.submit.succeeded.bell` i `invoice.submit.failed.bell` (po jednym
    // jobie na wysłaną fakturę, bez cronów; wzór trzeciej kolejki webhooków
    // z #595). Worker: 62 kolejek (60 + 2), cronów bez zmian („32/32 cronów”).
    // 60: od 11.11.2026 (krok 6.4, część 2) +1 job `document-archive-cleanup` (00190,
    // cron `cron.document-archive-cleanup` raz na dobę o 04:30). Worker: 63 kolejki, „33/33 cronów”.
    // 61: od 11.11.2026 (krok 8.1, część 3, 00197) +1 kolejka dzwonka
    // `invoice.payment.received.bell`: drugi odbiorca zdarzenia „wpłata zapisana” (obok
    // pusha), po jednym jobie na zapisaną wpłatę, bez cronów. Worker: 64 kolejki, „33/33 cronów”.
    expect(registered.length).toBe(61);
  });

  it('paczka W: 3 joby webhooków publicznego API (krok 7.1, część 3)', () => {
    const byQueue = new Map(registered.map((j) => [j.queue, j]));
    for (const q of ['webhooks.event.emitted', 'invoice.submit.succeeded.webhook', 'cron.webhooks-deliver']) {
      expect(queues, `brak ${q}`).toContain(q);
    }
    // Ponowienia dostaw prowadzi baza (harmonogram 1 min → 12 h, 00187), nie pg-boss:
    // cron bez ponowień (następny przebieg za minutę), zdarzenie z dwiema próbami
    // na chwilowy błąd bazy (dostawa ma UNIQUE, więc ponowienie od zera nie dubluje).
    expect(byQueue.get('cron.webhooks-deliver')?.maxRetries).toBe(0);
    expect(byQueue.get('webhooks.event.emitted')?.maxRetries).toBe(2);
    expect(byQueue.get('invoice.submit.succeeded.webhook')?.maxRetries).toBe(2);
  });

  it('dzwonek: 2 kolejki wyniku wysyłki do KSeF (krok 8.1, część 2) i kolejka wpłaty (część 3), ponowienia tylko na błąd bazy', () => {
    const byQueue = new Map(registered.map((j) => [j.queue, j]));
    // 2 → 3: wpłata do faktury (00197) to trzecia kolejka dzwonka.
    for (const q of ['invoice.submit.succeeded.bell', 'invoice.submit.failed.bell', 'invoice.payment.received.bell']) {
      expect(queues, `brak ${q}`).toContain(q);
      // Wpis ma UNIQUE (00188), więc ponowienie od zera nie dubluje powiadomienia.
      expect(byQueue.get(q)?.maxRetries).toBe(2);
    }
  });

  it('parytet limitów równoległości paczki C', () => {
    const byQueue = new Map(registered.map((j) => [j.queue, j]));
    expect(byQueue.get('ocr.process-photo')?.batchSize).toBe(5);
    expect(byQueue.get('inbox.invoice-received')?.batchSize).toBe(10);
    expect(byQueue.get('validation.bulk-contractors.requested')?.batchSize).toBe(3);
    // Paczka ZIP powstaje w pamięci workera (do 150 MB źródeł): jedna naraz.
    expect(byQueue.get('archive.document.requested')?.batchSize).toBe(1);
    expect(byQueue.get('archive.document.requested')?.localConcurrency ?? 1).toBe(1);
  });
});
