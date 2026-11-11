/**
 * Rejestr kolejek pg-boss: mapa zdarzeń (`lib/jobs/events.ts`) → nazwy
 * kolejek + definicje cronów. Jedyne źródło prawdy (Inngest odpięty, etap 10).
 *
 * Konwencja nazw: event 'invoice/submit.requested' → kolejka
 * 'invoice.submit.requested' (pg-boss preferuje [a-z0-9.-]).
 * Crony: kolejka 'cron.<id-joba-z-inngest>'.
 *
 * Test `tests/unit/jobs-queues.test.ts` pilnuje, żeby ta mapa nie
 * rozjechała się z eventami zdefiniowanymi w `lib/jobs/events.ts`.
 */

/**
 * Wszystkie eventy domenowe + wewnętrzne sekwencji e-mail (stan: 17 sie 2026).
 *
 * Wartość to TABLICA kolejek, bo Inngest pozwala wielu funkcjom słuchać tego
 * samego eventu (fan-out), a w pg-boss jedna kolejka = jeden handler.
 * Dwa takie eventy: `invoice/submit.succeeded` i `invoice/submit.failed`
 * (powiadomienie użytkownika ORAZ obsługa kolejki Offline24) — nadawca
 * publikuje do obu kolejek, co odtwarza semantykę Inngest 1:1.
 */
export const EVENT_QUEUE_MAP = {
  // Archiwum dokumentów i paczka na kontrolę (krok 6.4 planu kompletnej aplikacji, 00178).
  'archive/document.requested': ['archive.document.requested'],
  'billing/payment.failed': ['billing.payment.failed'],
  'billing/payment.succeeded': ['billing.payment.succeeded'],
  'email/trial-day-1': ['email.trial-day-1'],
  'email/trial-day-4': ['email.trial-day-4'],
  'email/trial-day-8': ['email.trial-day-8'],
  'email/trial-day-12': ['email.trial-day-12'],
  'email/trial-day-14': ['email.trial-day-14'],
  'exports/co-pilot.send-package': ['exports.co-pilot.send-package'],
  'exports/generate.requested': ['exports.generate.requested'],
  'import/file.uploaded': ['import.file.uploaded'],
  'inbox/invoice-received': ['inbox.invoice-received'],
  // Brak odbiorcy — na Inngest też nikt tego nie słucha. Pusta lista =
  // wysyłka nic nie publikuje (pg-boss rzuca na kolejce bez `createQueue`).
  'inbox/invoice.received': [],
  'inbox/poll.tenant': ['inbox.poll.tenant'],
  'invoice/payment.received': ['invoice.payment.received'],
  // fan-out: powiadomienie + obsługa kolejki Offline24
  'invoice/submit.failed': [
    'invoice.submit.failed.notify',
    'invoice.submit.failed.offline-queue',
  ],
  'invoice/submit.requested': ['invoice.submit.requested'],
  // fan-out: powiadomienie + obsługa kolejki Offline24
  'invoice/submit.succeeded': [
    'invoice.submit.succeeded.notify',
    'invoice.submit.succeeded.offline-queue',
  ],
  'invoice/upo.requested': ['invoice.upo.requested'],
  // Synchronizacja historii KSeF (decyzja Bartosza 22.10.2026): fan-out z crona.
  'ksef/history-sync.tenant': ['ksef.history-sync.tenant'],
  'ocr/process-photo': ['ocr.process-photo'],
  'reminders/send.requested': ['reminders.send.requested'],
  'user/registered': ['user.registered'],
  'validation/bulk-contractors.requested': ['validation.bulk-contractors.requested'],
} as const;

export type KnownJobEvent = keyof typeof EVENT_QUEUE_MAP;

/** Kolejki, do których trafia dany event (1 lub więcej — fan-out). */
export function queuesForEvent(eventName: string): readonly string[] {
  const queues = EVENT_QUEUE_MAP[eventName as KnownJobEvent];
  if (!queues) {
    throw new Error(
      `Nieznany event jobowy: "${eventName}" — dodaj do EVENT_QUEUE_MAP w lib/jobs/queues.ts`,
    );
  }
  return queues;
}

/** Wszystkie nazwy kolejek eventowych (do walidacji rejestru). */
export function allEventQueues(): string[] {
  return Object.values(EVENT_QUEUE_MAP).flat();
}

export interface CronJobDef {
  /** Nazwa kolejki (= 'cron.' + id joba z Inngest). */
  queue: string;
  /** Wyrażenie cron (5 pól). */
  cron: string;
  /** Strefa czasowa (pg-boss: ScheduleOptions.tz). */
  tz?: string;
}

const TZ = 'Europe/Warsaw';

/** 22 crony z inwentaryzacji (17 sie 2026, 1:1 z Inngest) + pg-bossowe: puls FLO, tryb cichy, heartbeat, historia KSeF, księgowość (K5), pliki paczek archiwum (6.4). */
export const CRON_JOBS: readonly CronJobDef[] = [
  { queue: 'cron.archive-old-invoices', cron: '0 3 * * *', tz: TZ },
  { queue: 'cron.cert-expiry-alert', cron: '0 8 * * *', tz: TZ },
  // Retencja dzienników paczkami (00157): codziennie, z budżetem czasu — przy
  // kadencji miesięcznej przebieg miał do usunięcia cały miesiąc wierszy naraz.
  { queue: 'cron.cleanup-audit-logs', cron: '0 3 * * *', tz: TZ },
  { queue: 'cron.cleanup-old-backups', cron: '0 4 * * *', tz: TZ },
  { queue: 'cron.co-pilot-monthly', cron: '0 8 * * *', tz: TZ },
  { queue: 'cron.critical-alerts-monitor', cron: '*/5 * * * *', tz: TZ },
  { queue: 'cron.daily-analytics-digest', cron: '0 6 * * *', tz: TZ },
  { queue: 'cron.daily-db-snapshot', cron: '0 2 * * *', tz: TZ },
  { queue: 'cron.daily-summary-email', cron: '0 6 * * *', tz: TZ },
  // Pliki wygasłych paczek archiwum (krok 6.4, część 2, 00190): raz na dobę o 04:30,
  // po retencji faktur i kopii (04:00). Jeden przebieg na dobę; plik znika najpóźniej
  // ok. doby po wygaśnięciu linku (7 dni od gotowości) i godzinie zapasu.
  { queue: 'cron.document-archive-cleanup', cron: '30 4 * * *', tz: TZ },
  // Puls agenta FLO: sprząta po sobie i (od bloku 3) tworzy propozycje.
  // 07:30, czyli po ciszy nocnej, a przed tym, jak ktokolwiek otworzy apkę.
  { queue: 'cron.flo-tick', cron: '30 7 * * *', tz: TZ },
  // Tryb cichy: raz w tygodniu dopisuje, co klient zrobił naprawdę (K3.2).
  // Poniedziałek 06:00 — przed pulsem, żeby tydzień zaczynał się od świeżej
  // trafności w panelu operatora.
  { queue: 'cron.flo-shadow-settle', cron: '0 6 * * 1', tz: TZ },
  { queue: 'cron.gdpr-process-deletions', cron: '0 * * * *' },
  // Co minutę, ale to lekki takt: bierze firmy należne według harmonogramu (00160)
  // do limitu slotów, więc żadna firma nie jest odpytywana co minutę. 1440 przebiegów
  // na dobę, 2 zapytania każdy. Założenie limitu: `INBOX_DISPATCH_TICK_SECONDS`.
  { queue: 'cron.inbox-polling', cron: '* * * * *', tz: TZ },
  // K2: co 15 minut domyka faktury bez kosztu/XML.
  { queue: 'cron.inbox-backfill', cron: '7,22,37,52 * * * *', tz: TZ },
  { queue: 'cron.jobs-watchdog', cron: '*/15 * * * *', tz: TZ },
  { queue: 'cron.ksef-health-check', cron: '* * * * *', tz: TZ },
  // Historia KSeF (decyzja Bartosza 22.10.2026): co 15 min — wybór firm i fan-out;
  // same pobrania mają własny budżet i ustępują skrzynce i wysyłce. 96 przebiegów na dobę.
  { queue: 'cron.ksef-history-sync', cron: '11,26,41,56 * * * *', tz: TZ },
  // Cykl życia faktury (PR 4b): co 15 min — I1 (queued bez zlecenia),
  // automatyczne ponowienia klasy transient (co godzinę, 24 h), wznowienie
  // po hamulcu. 96 lekkich przebiegów na dobę.
  { queue: 'cron.ksef-lifecycle-reconcile', cron: '3,18,33,48 * * * *', tz: TZ },
  // Raport dzienny cyklu życia dla operatora — 07:30, po pulsie FLO.
  { queue: 'cron.ksef-lifecycle-report', cron: '30 7 * * *', tz: TZ },
  // Moduł księgowości (K5, tylko firmy w pilotażu): 1-3. dnia miesiąca push
  // „rozliczenie za poprzedni miesiąc jest wyliczone” (jeden dzięki
  // tax_notifications, 00169) i codziennie przypomnienia o terminach.
  { queue: 'cron.ksiegowosc-miesiac', cron: '0 7 1-3 * *', tz: TZ },
  { queue: 'cron.ksiegowosc-terminy', cron: '0 8 * * *', tz: TZ },
  // Heartbeat dla zewnętrznego strażnika (lib/jobs/heartbeat.ts): ping co minutę
  // tylko wtedy, gdy harmonogram, worker i baza działają. Brak pinga = alarm.
  { queue: 'cron.ops-heartbeat', cron: '* * * * *', tz: TZ },
  { queue: 'cron.nightly-validation-recheck', cron: '0 4 * * *', tz: TZ },
  { queue: 'cron.process-offline-queue', cron: '*/5 * * * *', tz: TZ },
  { queue: 'cron.reminder-scheduler', cron: '0 * * * *', tz: TZ },
  { queue: 'cron.retention-delete', cron: '0 4 * * *', tz: TZ },
  // Retencja czatu pomocy: „do 24 miesięcy od ostatniej wiadomości” (polityka
  // prywatności). Codziennie — przy kadencji miesięcznej rozmowa żyłaby 25.
  { queue: 'cron.support-chat-retention', cron: '30 3 * * *', tz: TZ },
  { queue: 'cron.trial-countdown-emails', cron: '0 9 * * *', tz: TZ },
  { queue: 'cron.upo-retry-stale', cron: '5 * * * *', tz: TZ },
  { queue: 'cron.verify-backup', cron: '0 3 * * 0', tz: TZ },
  { queue: 'cron.weekly-business-review', cron: '0 9 * * 1', tz: TZ },
] as const;

/**
 * Crony wycofane — worker zdejmuje je z `pgboss.schedule` przy starcie.
 * Samo usunięcie z `CRON_JOBS` nie wystarcza: wpis z wcześniejszego startu
 * zostaje w tabeli i pg-boss dalej wysyła joby do kolejki bez workera.
 *
 * `refresh-materialized-views` (AUD-118): przeliczał co godzinę dwa widoki
 * na całej tabeli faktur, a nikt ich nie czytał. Widoki zostają w bazie
 * (bez DROP) — usunięcie to osobna decyzja.
 */
export const RETIRED_CRON_QUEUES = ['cron.refresh-materialized-views'] as const;

/**
 * Martwe kolejki pg-boss — worker usuwa je przy starcie (`deleteQueue`).
 * Zostały po dawnych nazwach zdarzeń i wycofanym cronie; nikt do nich nie
 * wysyła (EVENT_QUEUE_MAP ich nie zna) i nikt z nich nie czyta. Potwierdzone
 * na produkcji 03.10.2026 (rewizja, PR 4b). Usunięcie jest idempotentne.
 */
export const RETIRED_QUEUES = [
  'inbox.invoice.received',
  'invoice.submit.failed',
  'invoice.submit.succeeded',
  'cron.refresh-materialized-views',
  // Magiczny import wycofany 22.10.2026 (decyzja Bartosza) — historię pobiera
  // `ksef.history-sync.tenant`. Przed wdrożeniem: `ksef-historia.sh stare-importy` = 0.
  'import.ksef-history.requested',
] as const;

/** Kolejka testowa smoke (Etap 1/2 — weryfikacja fundamentu i połączenia). */
export const SMOKE_QUEUE = 'jobs.smoke';
