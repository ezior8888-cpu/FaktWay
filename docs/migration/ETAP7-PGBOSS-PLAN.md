# ETAP 7 — Plan migracji Inngest → pg-boss

> Utworzony 17 sierpnia 2026 na bazie pełnej inwentaryzacji kodu (nie pamięci).
> Stan wejściowy: Etapy 1-6 przeprowadzki zrobione; apka działa na Hetznerze,
> joby w tle nadal na Inngest Cloud (działają — zero presji czasowej).

---

## 0. Wynik inwentaryzacji (fakty z kodu, 17 sie 2026)

| Metryka | Wartość (zweryfikowana skryptem) |
|---|---|
| Funkcje zarejestrowane w `app/api/inngest/route.ts` | **46** |
| Joby cron | 20 (wszystkie `TZ=Europe/Warsaw` poza gdpr `0 * * * *`) |
| Joby eventowe | 26 (w tym 6 funkcji sekwencji e-maili + 2 handlery offline-queue) |
| Eventy zdefiniowane (`lib/inngest/client.ts`, zodEvent) | **24** (19 domenowych + 5 `emailTrialDay*`) |
| Punkty `inngest.send` w apce (poza jobami) | 9 plików / 14 wywołań |
| `step.sleep` KRÓTKIE (≤30 s; rate-limit, polling) | 6 plików — trywialne (worker to proces, wolno mu spać) |
| `step.sleep` DŁUGIE (dni) | email-sequence.ts: 6 funkcji, każda już emituje NASTĘPNY event po `sleep(Nd)` — redesign = `sendEvent(next, {startAfter: Nd})` zamiast sleep+send (zmiana jednoliniowa per funkcja, łańcuch zostaje) |
| `onFailure` | 4: submit-invoice, bulk-import, magic-import, process-ocr |
| `RetryAfterError` (custom schedule 30s→1h) | tylko submit-invoice |
| concurrency per-klucz (nip/tenant) | download-upo(3/nip), inbox(3/nip), magic-import(3/nip), dunning(1/tenant), submit(100/tenant) |
| throttle per-klucz | submit(60/min/tenant), upo(30/min/nip), inbox(8/h/nip) |

## 1. Architektura docelowa

```
┌─ app-1 ──────────────────────────────────────────────┐
│  [apka Next.js]──enqueue──┐      [worker] ← NOWY     │
│   (ten sam obraz,          │       kontener, ten sam  │
│    target: runner)         │       obraz, target:     │
│                            ▼       worker (tsx)       │
└────────────────────── pg-boss ───────┬────────────────┘
                    (schemat `pgboss`) │
┌─ db-1 ────────────────────────────── ▼ ───────────────┐
│  Postgres (Supabase) — DOTYCHCZASOWA baza, port 5432  │
│  wystawiony TYLKO na sieć prywatną Hetznera           │
└───────────────────────────────────────────────────────┘
```

Zasady nadrzędne:
1. **Parytet 1:1** logiki biznesowej — ciała jobów przenoszone niemal bez zmian
   przez shim `step.run/sleep/sendEvent` (audytowana logika zostaje nietknięta).
2. **`JOBS_BACKEND=inngest|pgboss`** — przełącznik na enqueue i na rejestracji
   `/api/inngest`. Domyślnie `inngest` przez CAŁY development → można bezpiecznie
   commitować/pushować paczki, kod pg-boss jest nieaktywny na prod aż do Etapu 9.
3. **Weryfikacja po każdym etapie**: typecheck + lint + vitest + build; commit
   po każdej paczce (za zgodą usera).
4. Rollback zawsze możliwy: flip env → `inngest` + restart (do Etapu 10).

## 2. Tabela parytetu (każdy feature Inngest → odpowiednik)

| Inngest | Odpowiednik w pg-boss/workerze |
|---|---|
| `cron('TZ=…')` | `boss.schedule(queue, cron, {tz})` — natywne wsparcie stref |
| event `inngest.send` | `boss.send(queueFor(event), data)`; mapa 1:1 event→kolejka |
| `step.sendEvent` (fan-out, tablice) | `boss.insert([...])` przez shim |
| `step.run(name, fn)` | shim: `await fn()` + log (bez memoizacji — patrz niżej) |
| memoizacja stepów przy retry | zastąpiona istniejącą idempotencją: guard w submit (ksef_status), R2 `IfNoneMatch`, unikalność P_2 w MF, `billing_notifications`, upserty — **audyt 18 lip potwierdził 3 niezależne warstwy** |
| `step.sleep` ≤30 s | zwykłe `setTimeout` w procesie (worker nie jest serverless) |
| `step.sleep` wielodniowe (email-sequence) | **redesign**: łańcuch jobów `startAfter: Nd` (etap→etap) |
| `retries: N` + backoff | własny wrapper: licznik `__attempt` w danych, re-send z `startAfter` |
| `RetryAfterError(msg, delay)` | klasa własna, wrapper honoruje delay (`getKsefRetryDelay` reużyty 1:1) |
| `NonRetriableError` | klasa własna → natychmiast `onExhausted` |
| `onFailure` | callback `onExhausted(error, data)` w definicji handlera |
| concurrency globalne (limit 1-10) | `work({batchSize})` per kolejka + jeden proces workera |
| concurrency/throttle per-NIP | **jeden proces workera** ⇒ istniejący in-process `ksefRateLimiter` staje się POPRAWNY globalnie (na Vercelu nie był — multi-instance); dodatkowo małe batchSize. Świadome uproszczenie, poprawne przy skali alpha |
| `logger` | pino-podobny prosty logger konsolowy (Coolify zbiera stdout) |
| dashboard Inngest (obserwowalność) | tabele `pgboss.job`/`archive` + healthcheck HTTP workera + istniejący jobs-watchdog (już dziś patrzy na tabele DOMENOWE, nie na Inngest — przenosi się bez zmian) |

## 3. Etapy

### ETAP 1 — Fundament `lib/jobs/` (sam kod, zero dotykania jobów)
Pliki: `errors.ts`, `duration.ts`, `config.ts` (JOBS_BACKEND/DATABASE_URL),
`queues.ts` (mapa 19 eventów + 20 cronów), `boss.ts` (singleton),
`enqueue.ts` (dispatcher wg backendu), `retry.ts` (czysta funkcja decyzyjna
+ wrapper), `step-shim.ts` (run/sleep≤120s/sendEvent), `worker.ts` (rejestr
handlerów, bootstrap schedulek TYLKO dla zarejestrowanych kolejek, healthcheck
HTTP, graceful shutdown, kolejka smoke). Dockerfile: target `worker`
(tsx + pełne node_modules). `scripts/pgboss-smoke.ts`. Testy unit:
duration, retry-decyzje, kompletność mapy eventów.
**DoD**: typecheck/lint/vitest/build zielone; smoke NIE wymaga jeszcze DB.

### ETAP 2 — Infrastruktura (jedyny etap z klikaniem usera)
1. **User**: Hetzner Console → db-1 → Networking → Attach to `faktflow-net`
   (bridge'e Dockera na db-1 to 172.x — sprawdzone, zero kolizji jak na ops-1).
2. **AI**: publish `5432` na prywatnym IP db-1 (edycja compose Supabase przez
   tinker) → user: redeploy Supabase.
3. **AI**: smoke pg-boss przez tunel SSH z Maca (`pnpm jobs:smoke`) — tworzy
   schemat `pgboss`, wysyła i odbiera job testowy.
**DoD**: smoke zielony; schemat `pgboss` istnieje obok `public` (nietknięty).

### ETAP 3 — Paczka A: crony utrzymaniowe (12 jobów, najniższe ryzyko)
refresh-materialized-views, cleanup-audit-logs, daily-db-snapshot,
verify-backup, cleanup-old-backups, retention-delete, archive-old-invoices,
nightly-validation-recheck, jobs-watchdog, ksef-health-check (co 1 min,
2 pingi z 30-sekundową pauzą w procesie), gdpr-process-deletions,
cert-expiry-alert. Wszystkie idempotentne, żaden nie wysyła e-maili do klientów.

### ETAP 4 — Paczka B: e-maile / billing / przypomnienia (17)
notify-success, notify-failure, **sekwencja: emailWelcome + emailDay1/4/8/12/14
(6 funkcji; każda już dziś emituje następny event po `sleep(Nd)` — port =
`sendEvent(next, {startAfter: Nd})` zamiast sleep+send, łańcuch bez zmian)**,
trial-countdown, dunning, daily-summary, weekly-review, critical-alerts,
daily-analytics-digest, reminder-scheduler, send-reminder,
cancel-reminders-on-payment. Idempotencja mailowa istnieje
(`billing_notifications`, preferences, bounce-guard).

### ETAP 5 — Paczka C: OCR / importy / eksporty (8)
process-ocr(+onFailure), auto-categorize-inbox (`autoCategorizeInboxInvoice`),
bulk-import(+onFailure), bulk-validate-contractors,
magic-import-ksef(+onFailure), exports-generate,
co-pilot-monthly, co-pilot-send-package.

### ETAP 6 — Paczka D: RDZEŃ KSeF (9, najwyższe ryzyko — na końcu, na rozgrzanym fundamencie)
**submit-invoice** (pełny parytet: schedule 30s→2m→5m→15m→1h z
`retry-schedule.ts`, klasyfikacja onFailure → rejected/offline_queued/failed,
Offline24, audyt), download-upo, upo-retry-stale, inbox-polling +
inbox-poll-tenant, process-offline-queue + **offlineQueueSuccessHandler +
offlineQueueFailureHandler** (2 handlery eventowe w tym samym pliku),
self-invoice-payment.
Testy symulacyjne wzorowane na `tests/mf-outage-simulation` i `ksef-mock`
przeciw nowemu wrapperowi.

### ETAP 7 — Punkty enqueue w apce + przełącznik rejestracji
9 plików (validation, reminders, exports, expenses, register,
magic-import×2, actions-detail, ksef-submit-enqueue, stripe/webhook-handlers)
→ `sendJobEvent()` z dispatchera. `/api/inngest/route.ts`: przy
`JOBS_BACKEND=pgboss` `serve()` z pustą listą (Inngest przestaje widzieć
funkcje ⇒ crony Cloud gasną; rollback = env flip + restart, bez rebuilda).

### ETAP 8 — Flagi: Edge Config → Postgres
Migracja `00060_global_feature_flags.sql`; refactor `lib/feature-flags/`
(ten sam interfejs, fail-soft zostaje); usunięcie `@vercel/edge-config` z deps.

### ETAP 9 — Cutover
Coolify: druga aplikacja z tego samego repo (Build Pack Dockerfile,
**target `worker`** — kolumna `dockerfile_target_build` istnieje), komplet env
+ `DATABASE_URL`; `JOBS_BACKEND=pgboss` na apce i workerze → redeploy obu.
E2E: faktura testowa przechodzi PEŁNY cykl (submit→numer KSeF→UPO→mail) bez
Inngest w łańcuchu. Tydzień obserwacji (Kuma + watchdog + Sentry).
**Playbook rollback**: `JOBS_BACKEND=inngest` na obu → restart → Inngest
z powrotem widzi funkcje. Uwaga: joby zakolejkowane w pg-boss w międzyczasie
NIE przeskoczą same do Inngest — po rollbacku sprawdzić `pgboss.job`
(stan `created`) i ręcznie ponowić z apki (skala alpha: pojedyncze sztuki).

### ETAP 10 — Decommission (po tygodniu stabilności)
Odpięcie appki w dashboardzie Inngest → usunięcie `lib/inngest/` + zależności
`inngest` z package.json (osobny commit; event-schematy zod przenieść do
`lib/jobs/` — są używane jako walidacja payloadów).

## 4. Ryzyka i decyzje

| Ryzyko | Mitygacja |
|---|---|
| pg-boss API pisane z pamięci | Etap 1 zaczyna się od instalacji i przeczytania `.d.ts` — kod przeciw realnym typom |
| Brak Dockera na Macu usera | build targetu `worker` weryfikowany dopiero na serwerze; do tego czasu tsx lokalnie + typecheck |
| Podwójne wykonywanie (Inngest + pg-boss) | niemożliwe konstrukcyjnie: jeden dispatcher + warunkowa rejestracja — zawsze dokładnie jeden backend aktywny |
| Sekwencja maili w locie podczas cutover | userzy w środku 14-dniowej sekwencji Inngest dokończą ją na Inngest (tydzień równoległości crona wystarcza dla day-8+; skala alpha: akceptowalne, odnotować przy cutover) |
| `tsx` + aliasy `@/*` w workerze | tsx wspiera tsconfig paths; fallback: bundling esbuild (decyzja przy pierwszym uruchomieniu) |
| Kolizja `emailTrialDay*` eventów | wyjaśnić przy Paczce B (mogą być wewnętrzne dla sekwencji) |

## 5. Postęp

- [x] ETAP 0 — inwentaryzacja (17 sie 2026)
- [x] Weryfikacja planu przeciw kodowi (17 sie 2026 — **46/46 jobów pokrytych (12+17+8+9), 24/24 eventów, 9/9 plików enqueue**; weryfikacja wyłapała 3 błędy pierwszej wersji planu: 6 funkcji sekwencji zamiast 1, 2 handlery offline, nazwa autoCategorize)
- [x] ETAP 1 — fundament (17 sie 2026: `lib/jobs/` 9 plików + worker target w Dockerfile + smoke script + 12 testów; typecheck/lint/109 vitest/66 node/build ✅; pg-boss 12.27 — nazwane exporty, grupy `groupConcurrency` dają NATYWNE per-tenant limity, lepiej niż zakładał plan)
- [x] ETAP 2 — infrastruktura (17 sie 2026: WYKRYTO i naprawiono duplikat sieci — app-1 wisiał w `appp-1` [literówka z lipca], oba serwery teraz w `faktflow-net`: db-1=10.0.0.2, app-1=10.0.0.3; port 5432 wystawiony TYLKO na 10.0.0.2 [live compose + docker_compose_raw w Coolify, backup .bak-etap7]; stack 15× healthy po odtworzeniu kontenera bazy; TCP z app-1 ✓, z internetu zamknięty ✓; smoke pg-boss ✅ roundtrip 2s, schemat `pgboss` 12 tabel)
- [x] ETAP 3 — Paczka A (17 sie 2026: 12 cronów sportowanych wzorcem „runner w pliku Inngest + delegacja" [jedno źródło prawdy logiki], rejestracje w `lib/jobs/handlers/package-a.ts`, adapter `lib/jobs/inngest-adapter.ts`, flaga `WORKER_DISABLE_SCHEDULES` do testów; **E2E ✅: lokalny worker przez tunel wykonał realny refresh-materialized-views na żywej bazie db-1** [`step ok: refresh-views`, job `completed` w pgboss.job]; typecheck/lint/109 vitest/build ✅)
- [x] ETAP 4 — Paczka B (17 sie 2026: 17 jobów — 6 cronów + 11 eventowych; **nowa abstrakcja `step.scheduleAfter`** (pg-boss: `startAfter`; Inngest: durable `sleep`+`sendEvent`) zamiast wielodniowych `step.sleep` w sekwencji e-mail — identyczne zachowanie na obu backendach, nazwy kroków wysyłki zachowane dla memoizacji Inngest; payloady typowane przez `Parameters<typeof event.create>[0]`; dunning per-tenant przez `groupConcurrency`; nowy test rejestru (30 kolejek, parytet retries); **E2E ✅ job eventowy z payloadem wykonany na żywej bazie** — wszystkie kroki + graceful obsługa braku adresata, `completed`; 115 vitest/build ✅)
- [x] ETAP 5 — Paczka C (17 sie 2026: 8 jobów OCR/importy/eksporty; `onFailure` → wspólne funkcje `onXExhausted` (3 joby); limity: `concurrency {limit:N}` → `batchSize`, per-NIP → `groupConcurrency`; typy payloadów wyprowadzone z sygnatur runnerów. **E2E WYKRYŁ KRYTYCZNY BŁĄD PARYTETU**: runnery rzucają klasy błędów INNGEST (`NonRetriableError`/`RetryAfterError`), których `decideRetry` nie rozpoznawał → job był ponawiany zamiast trafić do `onExhausted`. Fix: rozpoznawanie po `error.name` + odczyt `retryAfter` Inngest (SEKUNDY jako string). **To by wysadziło paczkę D** — cały schedule KSeF 30s→1h jedzie na `RetryAfterError`. 3 nowe testy regresji; 121 vitest ✅)
- [x] ETAP 6 — Paczka D (17 sie 2026: 9 jobów rdzenia KSeF. **Fan-out**: `EVENT_QUEUE_MAP` przebudowana na event→TABLICA kolejek, bo `invoice/submit.{succeeded,failed}` mają po 2 subskrybentów (powiadomienie + Offline24) — pominięcie = cicho martwy job. `submit-invoice` portowany ręcznie z asercjami granic; **zweryfikowane semantycznie: konfiguracja i sekwencja 20 kroków identyczne z Inngest**. `onExhausted` dostaje pełny JobContext (parkowanie Offline24 wymaga step.run). **DRUGI KRYTYCZNY FIX**: `import 'server-only'` w łańcuchu submit-invoice → worker padał na starcie w czystym Node; fix: jawna zależność `server-only` + `--conditions=react-server` w CMD Dockerfile i `worker:dev`, stub w vitest (27.10.2026, RUN-01: flagę zastąpił hak `lib/jobs/server-only-hook.mjs`, bo globalny warunek psuł render maili w workerze). E2E: worker wstał z 47 kolejkami, healthcheck OK. 126 vitest / 66 node / 18 FA(3) / build ✅)
- [x] ETAP 7 — enqueue + przełącznik (17 sie 2026: 14 wywołań `inngest.send` w 9 plikach → `sendJobEvent` z dispatchera; zero bezpośrednich wywołań Inngest w apce. Dispatcher zwraca `{ ids }` (zgodność z miejscami pokazującym userowi jobId) i obsługuje `groupId` PER EVENT (limity per tenant/NIP: submit-invoice, magic-import, billing). `/api/inngest/route.ts`: przy `JOBS_BACKEND=pgboss` rejestruje PUSTĄ listę → crony Inngest Cloud gasną, brak podwójnego wykonywania. Przełącznik zweryfikowany w 3 wariantach, w tym fail-safe przy literówce → inngest. 126 vitest / 66 node / build ✅)
- [x] ETAP 8 — flagi (17 sie 2026: migracja `00060_global_feature_flags` + `lib/feature-flags/global-flags.ts` [ten sam interfejs, Redis TTL 60 s, fail-soft], `@vercel/edge-config` USUNIĘTY z zależności — ostatnia zależność apki od Vercela. Migracja wgrana na prod, E2E odczyt/zapis/inwalidacja cache ✅. **GOTCHA self-hosted Supabase: po każdej migracji trzeba `NOTIFY pgrst, 'reload schema'`** — PostgREST cache'uje schemat i nie widzi nowych tabel [na Cloud dzieje się automatycznie]. Odkryto też, że lokalny `.env.local` wciąż celuje w Supabase Cloud — świadomie NIE zmieniam, żeby dev nie pisał do produkcji)
- [x] ETAP 9 — cutover (18 sie 2026: produkcja pracuje na pg-boss; worker to druga aplikacja w Coolify, id=2)
- [x] ETAP 10 — decommission (02.10.2026, B8): `lib/inngest/` → `lib/jobs/runners/` + `lib/jobs/events.ts` + `lib/jobs/errors.ts`; usunięte `/api/inngest`, opakowania `createFunction`, zależności `inngest`/`inngest-cli`, skrypty dev Inngest; `JOBS_BACKEND` = tylko `pgboss`. Zostaje poza kodem: odpięcie aplikacji w dashboardzie Inngest i usunięcie `INNGEST_*` z Coolify
